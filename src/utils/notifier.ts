/**
 * Transport-agnostic notification dispatcher.
 *
 * This is the single seam the rest of the app talks to for user-facing events.
 * It always logs to the console and, when a Telegram broadcaster is wired in at
 * startup, also pushes an HTML-formatted message. Business modules
 * (scanner/executor/monitor) call these functions and never import grammY.
 */
import type { Position, ScoredPair } from "../types/index.js";
import { log } from "./logger.js";
import { escapeHtml, formatScanResults, usd } from "./format.js";

/** Sends an HTML message to all allowed chats. Returns when done. */
export type Broadcaster = (htmlMessage: string) => Promise<void>;

let broadcaster: Broadcaster | undefined;

/**
 * Wire the optional Telegram broadcaster. Call once at startup; pass `undefined`
 * (or omit) to keep console-only behavior.
 */
export function initNotifier(broadcast?: Broadcaster): void {
  broadcaster = broadcast;
}

/** Internal: push to Telegram if wired, swallowing/logging transport errors. */
async function push(html: string): Promise<void> {
  if (!broadcaster) return;
  try {
    await broadcaster(html);
  } catch (err) {
    log.error(`Telegram broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function notifyScanResults(pairs: ScoredPair[]): Promise<void> {
  log.info(`Scan results: ${pairs.length} candidate pool(s).`);
  await push(formatScanResults(pairs));
}

export async function notifyPositionOpened(p: Position): Promise<void> {
  const msg =
    `🟢 <b>Position opened</b>\n` +
    `${escapeHtml(p.poolName)} (${p.strategy})\n` +
    `Deposit ${usd(p.initialDepositUsd)} · bins ${p.binLower}–${p.binUpper}`;
  log.info(`Position opened: ${p.poolName} ${usd(p.initialDepositUsd)}`);
  await push(msg);
}

export async function notifyPositionClosed(p: Position, pnlUsd: number): Promise<void> {
  const sign = pnlUsd >= 0 ? "+" : "-";
  const msg =
    `🔴 <b>Position closed</b>\n` +
    `${escapeHtml(p.poolName)}\n` +
    `Fees ${usd(p.feesCollectedUsd)} · PnL ${sign}${usd(Math.abs(pnlUsd))}`;
  log.info(`Position closed: ${p.poolName} PnL ${sign}${usd(Math.abs(pnlUsd))}`);
  await push(msg);
}

export async function notifyRebalance(
  poolName: string,
  fromBins: [number, number],
  toBins: [number, number],
): Promise<void> {
  const msg =
    `🔄 <b>Rebalance</b>\n` +
    `${escapeHtml(poolName)}\n` +
    `bins ${fromBins[0]}–${fromBins[1]} → ${toBins[0]}–${toBins[1]}`;
  log.info(`Rebalance: ${poolName} ${fromBins.join("-")} -> ${toBins.join("-")}`);
  await push(msg);
}

export async function notifyStopLoss(poolName: string, drawdownPct: number): Promise<void> {
  const msg =
    `⛔ <b>Stop-loss triggered</b>\n` +
    `${escapeHtml(poolName)} · drawdown ${(drawdownPct * 100).toFixed(1)}%`;
  log.warn(`Stop-loss: ${poolName} drawdown ${(drawdownPct * 100).toFixed(1)}%`);
  await push(msg);
}

export async function notifyStartup(dryRun: boolean): Promise<void> {
  const msg = `✅ <b>METEOR-FLOW online</b>\nDRY_RUN: <b>${dryRun}</b>`;
  log.info(`Startup (DRY_RUN=${dryRun})`);
  await push(msg);
}

export async function notifyShutdown(): Promise<void> {
  log.info("Shutting down.");
  await push("🛑 <b>METEOR-FLOW shutting down</b>");
}

export async function notifyError(message: string): Promise<void> {
  log.error(message);
  await push(`⚠️ <b>Error</b>\n${escapeHtml(message)}`);
}
