/**
 * Console logging and reporting helpers.
 */
import type { ScoredPair } from "../types/index.js";
import { usd } from "./format.js";

const ts = () => new Date().toISOString();

export const log = {
  info: (msg: string) => console.log(`[${ts()}] [INFO]  ${msg}`),
  warn: (msg: string) => console.warn(`[${ts()}] [WARN]  ${msg}`),
  error: (msg: string) => console.error(`[${ts()}] [ERROR] ${msg}`),
};

/** Pretty-print the top scored pools as an aligned table. */
export function printTopPairs(pairs: ScoredPair[]): void {
  if (pairs.length === 0) {
    log.warn("No pools matched the screening criteria.");
    return;
  }

  const rows = pairs.map((p, i) => ({
    rank: `${i + 1}`,
    name: p.name,
    tvl: usd(p.liquidity),
    vol24h: usd(p.trade_volume_24h),
    volTvl: p.volumeTvlRatio.toFixed(2),
    binStep: `${p.bin_step}`,
    score: p.score.toFixed(4),
  }));

  const headers = {
    rank: "#",
    name: "Pool",
    tvl: "TVL",
    vol24h: "Vol 24h",
    volTvl: "Vol/TVL",
    binStep: "Bin",
    score: "Score",
  };

  const cols = Object.keys(headers) as (keyof typeof headers)[];
  const width: Record<string, number> = {};
  for (const c of cols) {
    width[c] = Math.max(
      headers[c].length,
      ...rows.map((r) => r[c].length),
    );
  }

  const fmt = (r: Record<string, string>) =>
    cols.map((c) => r[c].padEnd(width[c])).join("  ");

  console.log("");
  console.log(fmt(headers));
  console.log(cols.map((c) => "-".repeat(width[c])).join("  "));
  for (const r of rows) console.log(fmt(r));
  console.log("");
}
