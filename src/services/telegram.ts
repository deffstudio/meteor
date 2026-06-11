/**
 * Telegram bot ("The Console") — grammY-based command interface + alert sink.
 *
 * Two-way: handles commands (/scan, /top, /status, /config, /help) and exposes
 * a `broadcast` used by the notifier to push alerts. Every update is gated by an
 * allowlist of chat IDs — this bot can control a funded trading system, so
 * unknown chats are denied before any handler runs.
 */
import { Bot } from "grammy";
import type { BotConfig, ScoredPair } from "../types/index.js";
import { log } from "../utils/logger.js";
import { formatScanResults, usd } from "../utils/format.js";
import { getDb } from "../utils/db.js";

/** Dependencies injected by the orchestrator to avoid an import cycle. */
export interface BotDeps {
  /** Run a fresh market scan and return the top pools. */
  runScan: () => Promise<ScoredPair[]>;
  /** Read the most recent scan results (may be empty before the first scan). */
  getLastScan: () => { pairs: ScoredPair[]; at: number | null };
}

export interface MeteorBot {
  /** Start long-polling (resolves once polling has begun). */
  start: () => void;
  /** Stop the bot gracefully. */
  stop: () => Promise<void>;
  /** Send an HTML message to every allowed chat. */
  broadcast: (html: string) => Promise<void>;
}

const HTML = { parse_mode: "HTML" as const };

function uptime(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

/** Build (but do not start) the Telegram bot. */
export function createBot(config: BotConfig, deps: BotDeps): MeteorBot {
  const { botToken, allowedChatIds } = config.telegram;
  if (!botToken) throw new Error("createBot called without a Telegram bot token.");

  const bot = new Bot(botToken);
  const startedAt = Date.now();
  let scanInFlight = false;

  // --- Auth: deny any chat not on the allowlist, before any other handler. ---
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !allowedChatIds.includes(chatId)) {
      log.warn(`Ignoring update from unauthorized chat: ${chatId ?? "unknown"}`);
      if (chatId !== undefined) {
        await ctx.reply("⛔ Unauthorized.").catch(() => {});
      }
      return; // stop the middleware chain
    }
    await next();
  });

  const helpText =
    "<b>METEOR-FLOW</b> commands:\n" +
    "/scan — run a fresh market scan\n" +
    "/top — show the last scan results\n" +
    "/status — bot status & open positions\n" +
    "/config — active screening thresholds\n" +
    "/help — this message\n\n" +
    `DRY_RUN: <b>${config.dryRun}</b>`;

  bot.command(["start", "help"], (ctx) => ctx.reply(helpText, HTML));

  bot.command("scan", async (ctx) => {
    if (scanInFlight) {
      await ctx.reply("⏳ A scan is already running…");
      return;
    }
    scanInFlight = true;
    try {
      await ctx.reply("🔭 Scanning Meteora DLMM pools…");
      const pairs = await deps.runScan();
      await ctx.reply(formatScanResults(pairs), HTML);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`⚠️ Scan failed: ${msg}`);
    } finally {
      scanInFlight = false;
    }
  });

  bot.command("top", async (ctx) => {
    const { pairs, at } = deps.getLastScan();
    if (at === null) {
      await ctx.reply("No scan yet — send /scan to run one.");
      return;
    }
    const age = Math.floor((Date.now() - at) / 1000);
    await ctx.reply(`${formatScanResults(pairs)}\n\n<i>as of ${age}s ago</i>`, HTML);
  });

  bot.command("status", async (ctx) => {
    const open = getDb()
      .prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'")
      .get() as { n: number };
    const { at } = deps.getLastScan();
    const lastScan = at === null ? "never" : `${Math.floor((Date.now() - at) / 1000)}s ago`;
    const interval =
      config.scanIntervalMinutes > 0 ? `${config.scanIntervalMinutes}m` : "off";
    const text =
      "<b>Status</b>\n" +
      `Uptime: ${uptime(startedAt)}\n` +
      `DRY_RUN: <b>${config.dryRun}</b>\n` +
      `Open positions: ${open.n}\n` +
      `Last scan: ${lastScan}\n` +
      `Auto-scan: ${interval}`;
    await ctx.reply(text, HTML);
  });

  bot.command("config", async (ctx) => {
    const c = config;
    const text =
      "<b>Screening config</b>\n" +
      `Min TVL: ${usd(c.minTvlUsd)}\n` +
      `Min Vol/TVL: ${c.minVolumeTvlRatio}\n` +
      `Bin step: ${c.binStepMin}–${c.binStepMax}\n` +
      `Top N: ${c.topN}\n` +
      `Max pools scanned: ${c.maxPoolsScan}\n` +
      `Max slippage: ${c.maxSlippageBps} bps`;
    await ctx.reply(text, HTML);
  });

  bot.catch((err) => {
    log.error(`grammY error: ${err.message}`);
  });

  const broadcast = async (html: string): Promise<void> => {
    await Promise.all(
      allowedChatIds.map((id) =>
        bot.api.sendMessage(id, html, HTML).catch((err) => {
          log.error(`Failed to message chat ${id}: ${err instanceof Error ? err.message : err}`);
        }),
      ),
    );
  };

  return {
    start: () => {
      // bot.start() resolves only when the bot stops; run it detached.
      void bot.start({ onStart: () => log.info("Telegram bot polling started.") });
    },
    stop: () => bot.stop(),
    broadcast,
  };
}
