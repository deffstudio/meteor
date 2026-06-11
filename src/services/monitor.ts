/**
 * Risk & Position Monitor ("The Guardian") — rebalance + stop-loss loop. STUB.
 *
 * Step 3 of the roadmap. Every 60s, checks each open position:
 *   - Rebalance trigger: `activeId` moved outside the deposited bin range.
 *   - Global stop-loss: total value dropped by X% vs. initial deposit.
 *   - Max rebalance count per hour to avoid fee bleeding from gas/slippage.
 */
import type { BotConfig, Position } from "../types/index.js";
import { log } from "../utils/logger.js";

export interface MonitorOptions {
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Stop-loss threshold as a fraction (e.g. 0.15 = -15%). */
  stopLossPct?: number;
  /** Max rebalances allowed per position per hour. */
  maxRebalancesPerHour?: number;
}

function notImplemented(what: string): never {
  throw new Error(`monitor.${what} is not implemented yet (Step 3).`);
}

/** True if the active bin has left the position's deposited range. */
export function isOutOfRange(_position: Position, _activeId: number): boolean {
  // TODO(step3): return activeId < binLower || activeId > binUpper.
  return notImplemented("isOutOfRange");
}

/** True if the position has breached the global stop-loss. */
export function isStopLossHit(position: Position, stopLossPct: number): boolean {
  if (position.initialDepositUsd <= 0) return false;
  const drawdown =
    (position.initialDepositUsd - position.currentValueUsd) / position.initialDepositUsd;
  return drawdown >= stopLossPct;
}

/** Start the monitoring loop. Skeleton only in this iteration. */
export async function startMonitorLoop(
  config: BotConfig,
  _options: MonitorOptions = {},
): Promise<void> {
  log.warn(
    `Monitor loop is not implemented yet (Step 3). DRY_RUN=${config.dryRun}. No positions are being managed.`,
  );
  // TODO(step3): setInterval(intervalMs): for each open position read activeId,
  // if isOutOfRange -> closePosition + swap to 50/50 + openPosition (re-center)
  //                    then notifier.notifyRebalance(name, fromBins, toBins);
  // if isStopLossHit -> closePosition + halt + notifier.notifyStopLoss(name, drawdown);
  // enforce maxRebalancesPerHour. Wrap ticks in try/catch -> notifier.notifyError.
}
