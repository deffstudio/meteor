/**
 * Swap Engine ("The Swapper") — Jupiter integration (spec §3B, roadmap Step 2).
 *
 * Uses the current Jupiter API at `${config.jupiterBaseUrl}` (default
 * https://api.jup.ag) with a free `x-api-key` from https://portal.jup.ag.
 * Quote API V6 (quote-api.jup.ag/v6) is retired.
 *
 *   GET  /swap/v1/quote   — route quote
 *   POST /swap/v1/swap    — build a signed-ready swap transaction
 *   GET  /price/v3        — token USD prices
 *
 * Slippage is taken from `config.maxSlippageBps`, which the config layer
 * hard-clamps to ≤ 100 bps (1%).
 */
import axios, { AxiosError, type AxiosInstance } from "axios";
import { type Connection } from "@solana/web3.js";
import type { BotConfig } from "../types/index.js";
import { getConnection, getWallet } from "../utils/connection.js";
import { deserializeVersionedTx, sendAndConfirm } from "../utils/transaction.js";
import { log } from "../utils/logger.js";

/** The Jupiter quote response (opaque; passed back verbatim to /swap). */
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: unknown[];
  [k: string]: unknown;
}

export interface SwapResult {
  /** Transaction signature, or null in DRY_RUN. */
  signature: string | null;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  dryRun: boolean;
}

export interface TokenPrice {
  usdPrice: number;
  decimals: number;
}

function client(config: BotConfig): AxiosInstance {
  return axios.create({
    baseURL: config.jupiterBaseUrl,
    timeout: 20_000,
    headers: {
      Accept: "application/json",
      ...(config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {}),
    },
  });
}

function describeAxiosError(err: unknown): string {
  const ax = err as AxiosError;
  if (ax.response) {
    return `HTTP ${ax.response.status} ${JSON.stringify(ax.response.data)}`;
  }
  return ax.code ?? ax.message ?? String(err);
}

/**
 * Fetch a swap quote. `amount` is in the input mint's smallest unit (raw).
 */
export async function getQuote(
  config: BotConfig,
  params: { inputMint: string; outputMint: string; amount: string },
): Promise<JupiterQuote> {
  try {
    const { data } = await client(config).get<JupiterQuote>("/swap/v1/quote", {
      params: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: config.maxSlippageBps,
        restrictIntermediateTokens: true,
      },
    });
    return data;
  } catch (err) {
    throw new Error(`Jupiter quote failed: ${describeAxiosError(err)}`);
  }
}

/**
 * Execute a swap from a prior quote: POST /swap to get the transaction, then
 * sign + send + confirm. In DRY_RUN, returns the expected amounts without
 * sending anything.
 */
export async function executeSwap(config: BotConfig, quote: JupiterQuote): Promise<SwapResult> {
  const base: Omit<SwapResult, "signature" | "dryRun"> = {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
  };

  if (config.dryRun) {
    log.info(
      `[DRY_RUN] swap ${quote.inAmount} ${quote.inputMint} -> ${quote.outAmount} ${quote.outputMint} ` +
        `(impact ${quote.priceImpactPct}%) — not sent.`,
    );
    return { ...base, signature: null, dryRun: true };
  }

  const wallet = getWallet(config);
  const connection: Connection = getConnection(config);

  let swapTransaction: string;
  try {
    const { data } = await client(config).post<{ swapTransaction: string }>("/swap/v1/swap", {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Let Jupiter estimate a sensible priority fee (refined further in Step 4).
      prioritizationFeeLamports: "auto",
    });
    swapTransaction = data.swapTransaction;
  } catch (err) {
    throw new Error(`Jupiter swap build failed: ${describeAxiosError(err)}`);
  }

  const tx = deserializeVersionedTx(swapTransaction);
  const signature = await sendAndConfirm(connection, tx, [wallet]);
  log.info(`Swap confirmed: ${signature}`);
  return { ...base, signature, dryRun: false };
}

/**
 * Fetch USD prices (and decimals) for one or more mints from Price API v3.
 * Returns a map keyed by mint address; missing mints are omitted.
 */
export async function getTokenUsdPrices(
  config: BotConfig,
  mints: string[],
): Promise<Record<string, TokenPrice>> {
  if (mints.length === 0) return {};
  try {
    const { data } = await client(config).get<
      Record<string, { usdPrice: number; decimals: number } | null>
    >("/price/v3", { params: { ids: mints.join(",") } });

    const out: Record<string, TokenPrice> = {};
    for (const [mint, info] of Object.entries(data)) {
      if (info && Number.isFinite(info.usdPrice)) {
        out[mint] = { usdPrice: info.usdPrice, decimals: info.decimals };
      }
    }
    return out;
  } catch (err) {
    throw new Error(`Jupiter price lookup failed: ${describeAxiosError(err)}`);
  }
}
