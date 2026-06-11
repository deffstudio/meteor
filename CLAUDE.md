# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

METEOR-FLOW is a Node.js/TypeScript bot that screens, opens, and manages Meteora DLMM
liquidity positions on Solana. Built in staged iterations: scanner → Telegram layer →
trading engine (Step 2, done) → monitor loop (Step 3, the remaining stub in `monitor.ts`).

## Commands

```bash
npm install            # better-sqlite3 is native; installs via prebuilt binary on Node 20
npm run scan           # one-shot: scan, print top-N table, exit (Telegram off)
npm run bot            # same entry; starts the Telegram bot when TELEGRAM_ENABLED=true
npm run dev            # tsx watch mode
npx tsc --noEmit       # type-check — THIS is the verification gate (see below)
npm run build          # tsc -> dist/
```

- **There is no test suite.** Do not invent test commands. Correctness is verified by
  `npx tsc --noEmit` (strict mode catches most issues) plus running `npm run scan`.
- `npm run scan` and `npm run bot` are the same entry point (`src/index.ts`); behavior is
  decided at runtime by `TELEGRAM_ENABLED`, not by the script.
- Copy `.env.example` to `.env` before running. The scanner needs no wallet key.

## Project conventions (important, easy to trip on)

- **ESM + strict TS.** `package.json` has `"type": "module"`. All relative imports MUST use
  the `.js` extension even though the source is `.ts` (e.g. `import { log } from "./logger.js"`).
  `tsconfig` has `noUnusedLocals`/`noUnusedParameters` on — unused imports fail the build.
- **DRY_RUN gates every on-chain action.** Default `true`. Swapper/executor compute and log
  intended amounts but send nothing unless `DRY_RUN=false`. Preserve this guard in any new
  trading code.
- **Slippage is hard-clamped to 1% (100 bps)** in `src/config/index.ts` regardless of env.
  Don't bypass it.

## Architecture (the big picture)

**Single mode-aware orchestrator.** `src/index.ts` loads config, inits SQLite, then forks:
- Telegram off → `runScan()` once, print, exit.
- Telegram on → `runBotMode()`: start the grammY bot (long-polling), optional auto-scan
  timer, stay alive until SIGINT/SIGTERM. `runScan()` only scans/caches/logs; **delivery is
  the caller's choice** — the auto-scan timer broadcasts via `notifyScanResults`, the `/scan`
  command replies once. (Conflating these caused a past double-message bug — keep them split.)

**The notifier is the decoupling seam.** `src/utils/notifier.ts` is the only thing business
modules call to surface events (`notifyScanResults`, `notifyPositionOpened/Closed`,
`notifyRebalance`, `notifyStopLoss`, `notifyError`, etc.). It always logs to console and, when
a broadcaster is wired at startup (`initNotifier(bot.broadcast)`), also pushes to Telegram.
**Scanner/executor/monitor must never import grammY** — they go through the notifier. The bot
gets `runScan`/`getLastScan` injected (no import cycle with `index.ts`).

**Services (`src/services/`)** are the modules; `src/utils/` are shared infra:
- `scanner.ts` — fetch/filter/score pools. Source of truth `scanMarket(config)`.
- `swapper.ts` — Jupiter quote/swap/price.
- `executor.ts` — DLMM `enterPosition`/`openPosition`/`closePosition`.
- `telegram.ts` — grammY bot: allowlist auth middleware (runs before every handler),
  commands, `broadcast()`.
- `utils/`: `connection.ts` (RPC + lazy wallet), `transaction.ts` (sign/send/confirm with
  retries, handles both legacy `Transaction` from the DLMM SDK and `VersionedTransaction` from
  Jupiter), `db.ts` (SQLite + idempotent migrations in `getDb()`), `format.ts`/`logger.ts`
  (shared `usd()` + console table), `notifier.ts`.

**External APIs — the original spec's endpoints are retired; use these:**
- Meteora pools: `https://dlmm.datapi.meteora.ag/pools` (NOT the old `dlmm-api.meteora.ag`).
  Paginated (`page` 1-based, `page_size`≤100), nested fields (`tvl`, `pool_config.bin_step`,
  `volume["24h"]`, `token_x/token_y.is_verified`). 100k+ pools sorted largest-first, so the
  scanner pulls a bounded `MAX_POOLS_SCAN` rather than paging everything.
- Jupiter: `https://api.jup.ag` with an `x-api-key` header (free key from portal.jup.ag).
  `GET /swap/v1/quote`, `POST /swap/v1/swap` (returns base64 `VersionedTransaction`),
  `GET /price/v3`.
- DLMM SDK: `@meteora-ag/dlmm` v1.9.x — `import DLMM, { StrategyType } from "@meteora-ag/dlmm"`.
  A newly created position is a fresh `Keypair` that must co-sign the open transaction.

**Persistence.** SQLite at `./data/meteor-flow.db` (`positions`, `performance` tables). Schema
changes go through the idempotent migration block in `getDb()` (PRAGMA-check then ALTER) so
existing DBs upgrade in place.

## Telegram

Two-way bot gated by an **allowlist** (`TELEGRAM_ALLOWED_CHAT_IDS`) — the auth middleware
rejects every non-listed chat before any command runs. Commands: `/scan`, `/top`, `/status`,
`/config`, `/help`. The bot is read/scan-only; it never sends transactions. Fund-moving
engine functions (`enterPosition`/`closePosition`) are intentionally NOT exposed as commands.
