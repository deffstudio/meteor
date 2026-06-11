/**
 * Shared type definitions for METEOR-FLOW.
 */

/** Position-building strategy for DLMM deposits. */
export type PositionStrategy = "Spot" | "Curve";

/**
 * A single DLMM pair as returned by the Meteora API
 * (`/pair/all_with_pagination`). Numeric figures arrive as strings and are
 * parsed at the fetch boundary — see `scanner.parsePair`.
 *
 * Only the fields used by the bot are typed; the API returns more.
 */
export interface MeteoraPair {
  /** Pool (LB pair) address. */
  address: string;
  /** Human-readable pair name, e.g. "SOL-USDC". */
  name: string;
  /** Bin step in basis points. */
  bin_step: number;
  /** Total value locked, in USD. */
  liquidity: number;
  /** 24h trade volume, in USD. */
  trade_volume_24h: number;
  /** 24h fees collected, in USD. */
  fees_24h: number;
  /** Fee/TVL ratio supplied by the API (informational). */
  fee_tvl_ratio: number;
  /** Current price of token X in token Y. */
  current_price: number;
  /** Base mint (token X). */
  mint_x: string;
  /** Quote mint (token Y). */
  mint_y: string;
  /** Whether the pair is verified by Meteora. */
  is_verified: boolean;
  /** Whether the pair is blacklisted. */
  is_blacklisted: boolean;
}

/** A `MeteoraPair` enriched with computed screening metrics. */
export interface ScoredPair extends MeteoraPair {
  /** volume_24h / TVL. */
  volumeTvlRatio: number;
  /** fees_24h / TVL. */
  feeTvlRatio: number;
  /** (fees_24h / TVL) * (volume_24h / TVL). Higher is better. */
  score: number;
}

/** Runtime configuration assembled from the environment. */
export interface BotConfig {
  rpcUrl: string;
  /** Base58 private key, or undefined when scanning only. */
  privateKey?: string;
  jupiterBaseUrl: string;
  jupiterApiKey?: string;
  /** When true, no transactions are sent. */
  dryRun: boolean;
  /** Screening thresholds. */
  minTvlUsd: number;
  minVolumeTvlRatio: number;
  binStepMin: number;
  binStepMax: number;
  topN: number;
  /**
   * Max number of pools to pull from the (size-sorted) API before filtering.
   * The API has 100k+ pools sorted largest-first; candidates live at the top,
   * so we bound the fetch instead of paging the entire universe.
   */
  maxPoolsScan: number;
  /** Max swap slippage in basis points (hard-clamped to 100). */
  maxSlippageBps: number;
  /** Telegram notification & control layer settings. */
  telegram: TelegramConfig;
  /** Auto-scan interval in minutes; 0 disables the timer. */
  scanIntervalMinutes: number;
}

/** Telegram bot configuration. */
export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  /** Allowlisted chat IDs; commands and alerts are restricted to these. */
  allowedChatIds: number[];
}

/** An open or closed LP position, persisted to SQLite. */
export interface Position {
  id?: number;
  poolAddress: string;
  poolName: string;
  /** On-chain position account address (needed to manage/close it). */
  positionPubkey: string;
  strategy: PositionStrategy;
  binLower: number;
  binUpper: number;
  initialDepositUsd: number;
  currentValueUsd: number;
  feesCollectedUsd: number;
  netProfit: number;
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
}
