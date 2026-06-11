/**
 * Shared formatting helpers used by both the console logger and Telegram messages.
 */
import type { ScoredPair } from "../types/index.js";

/** Compact USD formatting, e.g. $1.23M / $4.5k / $12.34. */
export function usd(n: number): string {
  return n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `$${(n / 1_000).toFixed(1)}k`
      : `$${n.toFixed(2)}`;
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build a Telegram-friendly (HTML parse mode) summary of scored pools.
 * Mirrors the columns shown in the console table.
 */
export function formatScanResults(pairs: ScoredPair[]): string {
  if (pairs.length === 0) {
    return "🔭 <b>Scan complete</b> — no pools matched the screening criteria.";
  }

  const lines = pairs.map((p, i) => {
    const name = escapeHtml(p.name);
    return (
      `<b>${i + 1}. ${name}</b>\n` +
      `   TVL ${usd(p.liquidity)} · Vol24h ${usd(p.trade_volume_24h)} · ` +
      `Vol/TVL ${p.volumeTvlRatio.toFixed(2)}\n` +
      `   Bin ${p.bin_step} · Score <b>${p.score.toFixed(4)}</b>`
    );
  });

  return `🔭 <b>Top ${pairs.length} DLMM pool(s)</b>\n\n${lines.join("\n\n")}`;
}
