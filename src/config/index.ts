/**
 * Environment loader and validation for METEOR-FLOW.
 *
 * Loads `.env`, applies safe defaults, and enforces hard safety limits
 * (notably the 1% slippage cap) regardless of user input.
 */
import "dotenv/config";
import type { BotConfig } from "../types/index.js";

/** Absolute hard cap on swap slippage — 1% — independent of env. */
const HARD_MAX_SLIPPAGE_BPS = 100;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function optionalStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

/** Parse a comma-separated list of integer chat IDs. */
function parseChatIds(name: string): number[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) {
        throw new Error(`Invalid chat id in ${name}: "${s}"`);
      }
      return n;
    });
}

/** Build and validate the bot configuration from the environment. */
export function loadConfig(): BotConfig {
  const rpcUrl = process.env.RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

  const requestedSlippage = num("MAX_SLIPPAGE_BPS", HARD_MAX_SLIPPAGE_BPS);
  const maxSlippageBps = Math.min(requestedSlippage, HARD_MAX_SLIPPAGE_BPS);
  if (requestedSlippage > HARD_MAX_SLIPPAGE_BPS) {
    console.warn(
      `[config] MAX_SLIPPAGE_BPS=${requestedSlippage} exceeds the hard cap; clamped to ${HARD_MAX_SLIPPAGE_BPS} (1%).`,
    );
  }

  const binStepMin = num("BIN_STEP_MIN", 10);
  const binStepMax = num("BIN_STEP_MAX", 100);
  if (binStepMin > binStepMax) {
    throw new Error(
      `BIN_STEP_MIN (${binStepMin}) must not exceed BIN_STEP_MAX (${binStepMax}).`,
    );
  }

  const telegramEnabled = bool("TELEGRAM_ENABLED", false);
  const telegramBotToken = optionalStr("TELEGRAM_BOT_TOKEN");
  const allowedChatIds = parseChatIds("TELEGRAM_ALLOWED_CHAT_IDS");
  if (telegramEnabled) {
    if (!telegramBotToken) {
      throw new Error(
        "TELEGRAM_ENABLED=true but TELEGRAM_BOT_TOKEN is not set. Create a bot via @BotFather.",
      );
    }
    if (allowedChatIds.length === 0) {
      throw new Error(
        "TELEGRAM_ENABLED=true but TELEGRAM_ALLOWED_CHAT_IDS is empty. " +
          "Set at least one chat id so the bot only responds to you.",
      );
    }
  }

  return {
    rpcUrl,
    privateKey: optionalStr("PRIVATE_KEY"),
    jupiterBaseUrl: process.env.JUPITER_BASE_URL?.trim() || "https://api.jup.ag",
    jupiterApiKey: optionalStr("JUPITER_API_KEY"),
    dryRun: bool("DRY_RUN", true),
    minTvlUsd: num("MIN_TVL_USD", 10_000),
    minVolumeTvlRatio: num("MIN_VOLUME_TVL_RATIO", 0.5),
    binStepMin,
    binStepMax,
    topN: num("TOP_N", 3),
    maxPoolsScan: num("MAX_POOLS_SCAN", 500),
    maxSlippageBps,
    telegram: {
      enabled: telegramEnabled,
      botToken: telegramBotToken,
      allowedChatIds,
    },
    scanIntervalMinutes: num("SCAN_INTERVAL_MINUTES", 0),
  };
}
