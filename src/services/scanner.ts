/**
 * Market Scanner ("The Scout") — spec §3A.
 *
 * Fetches every Meteora DLMM pair, filters for high-yield / high-utilization
 * pools, scores them, and returns the best candidates for entry.
 */
import axios, { AxiosError } from "axios";
import type { BotConfig, MeteoraPair, ScoredPair } from "../types/index.js";

const METEORA_API = "https://dlmm.datapi.meteora.ag";
const PAGE_SIZE = 100;
/** Small delay between pages to stay well under the 30 RPS API limit. */
const PAGE_DELAY_MS = 150;

/** A bucketed metrics map keyed by window, e.g. { "24h": 123.4 }. */
type Buckets = Record<string, number | string>;

/** Raw pool shape from the datapi `/pools` endpoint (nested objects). */
interface RawPool {
  address: string;
  name: string;
  tvl: number | string;
  current_price: number | string;
  is_blacklisted?: boolean;
  pool_config?: { bin_step?: number | string };
  token_x?: { address?: string; is_verified?: boolean };
  token_y?: { address?: string; is_verified?: boolean };
  volume?: Buckets;
  fees?: Buckets;
  fee_tvl_ratio?: Buckets;
}

interface PoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: RawPool[];
}

const toNum = (v: number | string | undefined): number => {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize a raw datapi pool into a typed `MeteoraPair`. */
function parsePair(raw: RawPool): MeteoraPair {
  return {
    address: raw.address,
    name: raw.name,
    bin_step: toNum(raw.pool_config?.bin_step),
    liquidity: toNum(raw.tvl),
    trade_volume_24h: toNum(raw.volume?.["24h"]),
    fees_24h: toNum(raw.fees?.["24h"]),
    fee_tvl_ratio: toNum(raw.fee_tvl_ratio?.["24h"]),
    current_price: toNum(raw.current_price),
    mint_x: raw.token_x?.address ?? "",
    mint_y: raw.token_y?.address ?? "",
    // A pair is "verified" only if both underlying tokens are verified.
    is_verified: Boolean(raw.token_x?.is_verified && raw.token_y?.is_verified),
    is_blacklisted: raw.is_blacklisted ?? false,
  };
}

/**
 * Fetch pools from the datapi `/pools` endpoint, which returns them sorted
 * largest-first. We page until `maxPoolsScan` pools are collected (or the data
 * runs out) rather than walking all 100k+ pools — candidates cluster at the top.
 *
 * Throws a descriptive error if the API is unreachable.
 */
export async function fetchAllPairs(maxPoolsScan: number): Promise<MeteoraPair[]> {
  const pairs: MeteoraPair[] = [];

  try {
    for (let page = 1; pairs.length < maxPoolsScan; page++) {
      const { data } = await axios.get<PoolsResponse>(`${METEORA_API}/pools`, {
        params: { page, page_size: PAGE_SIZE },
        timeout: 20_000,
        headers: { Accept: "application/json" },
      });

      const batch = data?.data ?? [];
      for (const raw of batch) pairs.push(parsePair(raw));

      if (batch.length < PAGE_SIZE || page >= (data?.pages ?? page)) break;
      await sleep(PAGE_DELAY_MS);
    }
  } catch (err) {
    const ax = err as AxiosError;
    const detail = ax.response ? `HTTP ${ax.response.status}` : ax.code ?? ax.message;
    throw new Error(
      `Failed to fetch Meteora pools from ${METEORA_API}/pools (${detail}). ` +
        `Check your network connection and that the API is reachable.`,
    );
  }

  return pairs.slice(0, maxPoolsScan);
}

/** Apply the §3A screening filters. */
export function filterPairs(pairs: MeteoraPair[], config: BotConfig): MeteoraPair[] {
  return pairs.filter((p) => {
    if (p.is_blacklisted || !p.is_verified) return false;
    if (p.liquidity <= config.minTvlUsd) return false;
    if (p.bin_step < config.binStepMin || p.bin_step > config.binStepMax) return false;
    const volumeTvlRatio = p.liquidity > 0 ? p.trade_volume_24h / p.liquidity : 0;
    return volumeTvlRatio > config.minVolumeTvlRatio;
  });
}

/**
 * Score and sort pairs by capital efficiency.
 * `score = (fees_24h / TVL) * (volume_24h / TVL)`.
 */
export function scorePairs(pairs: MeteoraPair[]): ScoredPair[] {
  return pairs
    .map((p): ScoredPair => {
      const feeTvlRatio = p.liquidity > 0 ? p.fees_24h / p.liquidity : 0;
      const volumeTvlRatio = p.liquidity > 0 ? p.trade_volume_24h / p.liquidity : 0;
      return {
        ...p,
        feeTvlRatio,
        volumeTvlRatio,
        score: feeTvlRatio * volumeTvlRatio,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Full scan pipeline: fetch → filter → score → top N.
 * Returns the highest-scoring candidate pools.
 */
export async function scanMarket(config: BotConfig): Promise<ScoredPair[]> {
  const all = await fetchAllPairs(config.maxPoolsScan);
  const filtered = filterPairs(all, config);
  const scored = scorePairs(filtered);
  return scored.slice(0, config.topN);
}
