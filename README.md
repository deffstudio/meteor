# METEOR-FLOW

Automated Liquidity Provider (LP) system for **Meteora DLMM** on Solana. The goal is
sustainable fee capture with active impermanent-loss management.

> **Status — scanner + Telegram layer + trading engine (Step 2).**
> Scanner, Telegram bot, Jupiter swapper, and DLMM executor are implemented. The monitor
> (rebalance/stop-loss) remains a Step 3 stub. **`DRY_RUN=true` by default — flip it off only
> with a funded wallet and after review.**

## Architecture

```
/src
  index.ts              Orchestrator (scan-once, or Telegram bot mode)
  /config   index.ts    Env loader + thresholds (slippage hard-clamped to 1%)
  /types    index.ts    Shared interfaces (MeteoraPair, ScoredPair, Position, BotConfig)
  /services
    scanner.ts          IMPLEMENTED — fetch + filter + score Meteora pairs
    telegram.ts         IMPLEMENTED — grammY bot: commands + alert broadcast
    swapper.ts          IMPLEMENTED — Jupiter quote/swap/price (api.jup.ag)
    executor.ts         IMPLEMENTED — DLMM enter/open/close (Spot strategy)
    monitor.ts          STUB — rebalance + stop-loss loop (Step 3)
  /utils
    connection.ts       RPC + wallet (wallet loaded lazily; not needed to scan)
    transaction.ts      Sign/send/confirm with retries (legacy + versioned tx)
    db.ts               SQLite schema + prepared statements
    format.ts           Shared USD / message formatting
    notifier.ts         Transport-agnostic event dispatcher (console + Telegram)
    logger.ts           Console output + top-N table
```

### Scanner logic (spec §3A)
1. Fetch pools from the Meteora data API `https://dlmm.datapi.meteora.ag/pools`
   (the legacy `dlmm-api.meteora.ag/pair/all` host is retired). Pools come sorted
   largest-first; we pull up to `MAX_POOLS_SCAN` rather than all 100k+.
2. Filter: `TVL > MIN_TVL_USD`, `volume24h / TVL > MIN_VOLUME_TVL_RATIO`,
   `bin_step ∈ [BIN_STEP_MIN, BIN_STEP_MAX]`, both tokens verified, not blacklisted.
3. Score: `(fees_24h / TVL) * (volume_24h / TVL)`.
4. Return the top `TOP_N` pools.

## Setup

Requires **Node.js 20+**.

```bash
cp .env.example .env      # then edit values
npm install
npm run scan
```

### Windows note — native module
`better-sqlite3` compiles native bindings. If `npm install` fails on Windows, install the
build toolchain (one-time):

```powershell
# Easiest: install "Desktop development with C++" via Visual Studio Build Tools,
# then ensure a matching Python 3 is on PATH. Afterwards:
npm install
```

If you prefer a prebuilt binary, recent `better-sqlite3` releases ship prebuilds for Node 20
that usually install without a compiler.

## Usage

| Command            | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `npm run scan`     | One-shot: fetch, filter, score, print top pools, exit.|
| `npm run bot`      | Start the Telegram bot (when `TELEGRAM_ENABLED=true`).|
| `npm run typecheck`| Type-check the whole project (`tsc --noEmit`).       |
| `npm run dev`      | Run in watch mode.                                   |

The scanner needs **no wallet key** — leave `PRIVATE_KEY` blank to screen pools safely.

## Telegram (monitor & control)

Run METEOR-FLOW as a Telegram bot to trigger scans and receive alerts from your phone.

**Setup:**
1. In Telegram, message **@BotFather** → `/newbot`, follow the prompts, copy the **token**.
2. Find your numeric chat ID — message **@userinfobot**, or start your bot and check `/status`.
3. In `.env`:
   ```
   TELEGRAM_ENABLED=true
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_ALLOWED_CHAT_IDS=<your chat id>   # comma-separated for multiple
   SCAN_INTERVAL_MINUTES=0                     # >0 to auto-push scans on a timer
   ```
4. `npm run bot`

**Commands:** `/scan` (fresh scan), `/top` (last results), `/status`, `/config`, `/help`.

**Alerts** are pushed for scan results, startup/shutdown, errors, and — once Steps 2/3 land —
position open/close, rebalances, and stop-loss events.

**Security:** only the chat IDs in `TELEGRAM_ALLOWED_CHAT_IDS` can use the bot; every other
update is rejected. The bot only reads/scans — it never sends transactions. Keep the token in
`.env` (git-ignored). When `TELEGRAM_ENABLED=false` (default), `npm run scan` behaves exactly
as a plain one-shot scan.

## Safety

- `DRY_RUN=true` by default. Keep it on until the executor/swapper are implemented and you
  have reviewed them.
- Max swap slippage is hard-clamped to **1% (100 bps)** in code.
- Private keys live only in `.env`, which is git-ignored. Never commit a real key.

## Trading engine (Step 2)

Implemented in `swapper.ts` + `executor.ts`, all gated by `DRY_RUN`:

- **`getQuote` / `executeSwap`** — Jupiter `GET /swap/v1/quote` + `POST /swap/v1/swap`
  (requires `JUPITER_API_KEY`). Slippage is the clamped `MAX_SLIPPAGE_BPS` (≤1%).
- **`getTokenUsdPrices`** — Jupiter `GET /price/v3` for USD valuation.
- **`enterPosition(pair, depositUsd)`** — auto-balancing entry: prices both tokens, swaps
  ~half the deposit (held in the quote token) into the base token, then opens 50/50.
- **`openPosition`** — `initializePositionAndAddLiquidityByStrategy` (Spot) across ±10 bins
  around the active bin; persists to SQLite and fires a Telegram alert.
- **`closePosition`** — `removeLiquidity` 100% with `shouldClaimAndClose`, marks the row closed.

A funded wallet (`PRIVATE_KEY`) and `JUPITER_API_KEY` are required to run live. With
`DRY_RUN=true`, entries/exits compute and log amounts but send nothing on-chain.

## Roadmap

- **Done** — Market scanner; two-way Telegram layer; Jupiter swaps + DLMM Spot deposit/withdraw.
- **Step 3** — 60s monitor loop: rebalance on out-of-range, global stop-loss, rebalance cap.
- **Step 4** — Priority fees, retries on `sendAndConfirmTransaction`, cumulative fee logging.
