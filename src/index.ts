/**
 * METEOR-FLOW orchestrator.
 *
 * Two run modes from the same entry point:
 *   - Telegram OFF (default): one-shot scan → print table → exit.
 *   - Telegram ON: start the grammY bot (commands + alerts), optional auto-scan
 *     timer, and stay alive until SIGINT/SIGTERM.
 */
import type { BotConfig, ScoredPair } from "./types/index.js";
import { loadConfig } from "./config/index.js";
import { scanMarket } from "./services/scanner.js";
import { createBot, type MeteorBot } from "./services/telegram.js";
import { getDb } from "./utils/db.js";
import { log, printTopPairs } from "./utils/logger.js";
import {
  initNotifier,
  notifyError,
  notifyScanResults,
  notifyShutdown,
  notifyStartup,
} from "./utils/notifier.js";

/** Most recent scan, shared with the bot's /top command. */
const lastScan: { pairs: ScoredPair[]; at: number | null } = { pairs: [], at: null };

/**
 * Run a scan, cache it, and print to console. Single source of truth.
 * Delivery (broadcast vs. direct reply) is the caller's choice, so manual
 * /scan replies once and only the auto-scan timer broadcasts.
 */
async function runScan(config: BotConfig): Promise<ScoredPair[]> {
  log.info("Scanning Meteora DLMM pools...");
  const pairs = await scanMarket(config);
  lastScan.pairs = pairs;
  lastScan.at = Date.now();
  log.info(`Scan complete — ${pairs.length} candidate pool(s).`);
  printTopPairs(pairs);
  return pairs;
}

/** Telegram mode: start the bot, optional auto-scan, run until terminated. */
async function runBotMode(config: BotConfig): Promise<void> {
  const bot: MeteorBot = createBot(config, {
    runScan: () => runScan(config),
    getLastScan: () => lastScan,
  });

  initNotifier(bot.broadcast);
  bot.start();
  await notifyStartup(config.dryRun);

  // Optional periodic auto-scan that pushes results to allowed chats.
  let timer: NodeJS.Timeout | undefined;
  if (config.scanIntervalMinutes > 0) {
    const ms = config.scanIntervalMinutes * 60_000;
    log.info(`Auto-scan enabled every ${config.scanIntervalMinutes} minute(s).`);
    timer = setInterval(() => {
      runScan(config)
        .then((pairs) => notifyScanResults(pairs))
        .catch((err: unknown) =>
          notifyError(err instanceof Error ? err.message : String(err)),
        );
    }, ms);
  }

  // Keep the process alive until a termination signal, then shut down cleanly.
  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log.info(`Received ${signal}, shutting down...`);
      if (timer) clearInterval(timer);
      void notifyShutdown()
        .then(() => bot.stop())
        .finally(resolve);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  log.info(`METEOR-FLOW starting (DRY_RUN=${config.dryRun})`);
  log.info(
    `Filters: TVL > $${config.minTvlUsd.toLocaleString()}, ` +
      `Vol/TVL > ${config.minVolumeTvlRatio}, ` +
      `bin_step ${config.binStepMin}-${config.binStepMax}, top ${config.topN}`,
  );

  // Initialize persistence up front so the schema exists before any trading step.
  getDb();
  log.info("SQLite ready at ./data/meteor-flow.db");

  if (config.telegram.enabled) {
    log.info("Telegram enabled — starting bot mode.");
    await runBotMode(config);
  } else {
    initNotifier(); // console-only
    await runScan(config);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(msg);
  process.exitCode = 1;
});
