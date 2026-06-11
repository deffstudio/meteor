/**
 * Execution Engine ("The Executor") — DLMM deposits/withdrawals (spec §3B, Step 2).
 *
 * Uses the Meteora DLMM SDK (`@meteora-ag/dlmm` v1.9.x):
 *   - openPosition: initialize a position and add liquidity by strategy (Spot
 *     by default) across ±binSpread bins centered on the active bin.
 *   - closePosition: remove 100% liquidity, claim fees, and close the account.
 *   - enterPosition: auto-balancing entry — split `depositUsd` ~50/50 by USD,
 *     swapping the X side in via Jupiter, then open the position.
 *
 * All on-chain actions are gated by `config.dryRun`.
 */
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { BotConfig, Position, PositionStrategy, ScoredPair } from "../types/index.js";
import { getConnection, getWallet } from "../utils/connection.js";
import { insertPosition, markPositionClosed } from "../utils/db.js";
import { sendAndConfirm, sendAllInOrder } from "../utils/transaction.js";
import { log } from "../utils/logger.js";
import { notifyPositionClosed, notifyPositionOpened } from "../utils/notifier.js";
import { executeSwap, getQuote, getTokenUsdPrices } from "./swapper.js";

/** Default half-width of the bin range around the active bin (≈20 bins total). */
const DEFAULT_BIN_SPREAD = 10;

const STRATEGY_TYPE: Record<PositionStrategy, StrategyType> = {
  Spot: StrategyType.Spot,
  Curve: StrategyType.Curve,
};

export interface OpenPositionParams {
  pair: ScoredPair;
  strategy: PositionStrategy;
  /** Token X amount in raw (smallest) units. */
  totalXAmount: BN;
  /** Token Y amount in raw (smallest) units. */
  totalYAmount: BN;
  /** USD value of the deposit, for record-keeping. */
  depositUsd: number;
  /** Bins each side of the active bin. */
  binSpread?: number;
}

export interface OpenPositionResult {
  position: Position;
  signature: string | null;
  dryRun: boolean;
}

export interface EnterPositionParams {
  pair: ScoredPair;
  strategy: PositionStrategy;
  /** Total USD to deploy (~50/50 across both sides). */
  depositUsd: number;
  binSpread?: number;
}

/**
 * Open a DLMM position with the given raw token amounts, distributed by strategy
 * across `±binSpread` bins around the current active bin.
 */
export async function openPosition(
  config: BotConfig,
  params: OpenPositionParams,
): Promise<OpenPositionResult> {
  const { pair, strategy, totalXAmount, totalYAmount, depositUsd } = params;
  const binSpread = params.binSpread ?? DEFAULT_BIN_SPREAD;

  const connection = getConnection(config);
  const dlmm = await DLMM.create(connection, new PublicKey(pair.address));
  const activeBin = await dlmm.getActiveBin();
  const minBinId = activeBin.binId - binSpread;
  const maxBinId = activeBin.binId + binSpread;

  const positionKp = Keypair.generate();
  log.info(
    `Opening ${strategy} position on ${pair.name}: bins ${minBinId}–${maxBinId} ` +
      `(active ${activeBin.binId}), X=${totalXAmount.toString()} Y=${totalYAmount.toString()}`,
  );

  const position: Position = {
    poolAddress: pair.address,
    poolName: pair.name,
    positionPubkey: positionKp.publicKey.toBase58(),
    strategy,
    binLower: minBinId,
    binUpper: maxBinId,
    initialDepositUsd: depositUsd,
    currentValueUsd: depositUsd,
    feesCollectedUsd: 0,
    netProfit: 0,
    status: "open",
    openedAt: Date.now(),
  };

  if (config.dryRun) {
    log.info(`[DRY_RUN] position not opened on-chain.`);
    return { position, signature: null, dryRun: true };
  }

  const wallet = getWallet(config);
  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId, maxBinId, strategyType: STRATEGY_TYPE[strategy] },
    slippage: config.maxSlippageBps / 100,
  });

  // The new position account must also sign.
  const signature = await sendAndConfirm(connection, tx, [wallet, positionKp]);
  position.id = insertPosition(position);
  await notifyPositionOpened(position);
  log.info(`Position opened: ${signature}`);
  return { position, signature, dryRun: false };
}

/**
 * Auto-balancing entry: price both tokens, swap ~half the deposit (held in the
 * quote token Y) into token X via Jupiter, then open the position 50/50.
 */
export async function enterPosition(
  config: BotConfig,
  params: EnterPositionParams,
): Promise<OpenPositionResult> {
  const { pair, strategy, depositUsd } = params;

  const prices = await getTokenUsdPrices(config, [pair.mint_x, pair.mint_y]);
  const px = prices[pair.mint_x];
  const py = prices[pair.mint_y];
  if (!px || !py) {
    throw new Error(
      `Missing USD price for ${!px ? pair.mint_x : pair.mint_y}; cannot size the entry.`,
    );
  }

  const halfUsd = depositUsd / 2;
  const rawFor = (usdAmount: number, p: { usdPrice: number; decimals: number }): string =>
    BigInt(Math.floor((usdAmount / p.usdPrice) * 10 ** p.decimals)).toString();

  // Half stays in Y; the other half of Y is swapped into X.
  const yRawHalf = rawFor(halfUsd, py);
  log.info(
    `Entering ${pair.name} with ~$${depositUsd}: swapping ~$${halfUsd} of ${pair.mint_y} into ${pair.mint_x}.`,
  );

  const quote = await getQuote(config, {
    inputMint: pair.mint_y,
    outputMint: pair.mint_x,
    amount: yRawHalf,
  });
  const swap = await executeSwap(config, quote);

  const totalXAmount = new BN(swap.outAmount);
  const totalYAmount = new BN(yRawHalf);

  return openPosition(config, {
    pair,
    strategy,
    totalXAmount,
    totalYAmount,
    depositUsd,
    binSpread: params.binSpread,
  });
}

/**
 * Withdraw all liquidity, claim fees, and close a position.
 * Returns realized fee/withdrawal figures (best-effort in USD via Jupiter prices).
 */
export async function closePosition(
  config: BotConfig,
  position: Position,
): Promise<{ signatures: string[]; dryRun: boolean }> {
  const connection = getConnection(config);
  const wallet = getWallet(config);
  const dlmm = await DLMM.create(connection, new PublicKey(position.poolAddress));

  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  const onchain = userPositions.find(
    (p) => p.publicKey.toBase58() === position.positionPubkey,
  );
  if (!onchain) {
    throw new Error(`On-chain position ${position.positionPubkey} not found for this wallet.`);
  }

  if (config.dryRun) {
    log.info(`[DRY_RUN] would close position ${position.positionPubkey} on ${position.poolName}.`);
    return { signatures: [], dryRun: true };
  }

  // Remove 100% and claim+close in one shot.
  const txs = await dlmm.removeLiquidity({
    user: wallet.publicKey,
    position: onchain.publicKey,
    fromBinId: onchain.positionData.lowerBinId,
    toBinId: onchain.positionData.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });

  const signatures = await sendAllInOrder(connection, txs, [wallet]);

  // Best-effort PnL from stored values; precise USD fee accounting lands in Step 4.
  const netProfit = position.currentValueUsd - position.initialDepositUsd;
  if (position.id !== undefined) {
    markPositionClosed(position.id, {
      feesCollectedUsd: position.feesCollectedUsd,
      currentValueUsd: position.currentValueUsd,
      netProfit,
    });
  }
  await notifyPositionClosed(position, netProfit);
  log.info(`Position closed: ${signatures.join(", ")}`);
  return { signatures, dryRun: false };
}
