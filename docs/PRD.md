# Product Requirements: METEOR-FLOW (Meteora DLMM Automated LP Bot)

> Living PRD. Edit via a feature branch + PR (see `CONTRIBUTING.md`). Record notable changes in
> the [Changelog](#changelog).

## 1. Project Overview
Build a Node.js/TypeScript automated system to screen, execute, and manage Liquidity Provider
(LP) positions on Meteora DLMM (Dynamic Liquidity Market Maker) on the Solana blockchain. The
goal is sustainable revenue through high fee capture while minimizing Impermanent Loss (IL).

## 2. Tech Stack
- **Runtime:** Node.js (v20+)
- **Language:** TypeScript (strict, ESM)
- **Blockchain:** `@solana/web3.js`, `@meteora-ag/dlmm`
- **Trading/Swaps:** Jupiter (`api.jup.ag`)
- **Data:** Axios; Meteora data API; Jupiter Price API
- **State:** SQLite (`better-sqlite3`) for position/performance tracking
- **Notifications/Control:** Telegram via grammY
- **Environment:** `.env` for private keys, RPC URLs, and API keys

## 3. Core Modules & Logic

### A. Market Scanner ("The Scout")
Identify high-yield, high-utilization pools.
- **Source:** Meteora DLMM data API (see §Deviations for the current endpoint).
- **Filters:** Min TVL > $10,000; Min Volume/TVL > 0.5; Bin Step 10–100; exclude
  blacklisted/unverified tokens.
- **Score:** `(24h_Fee / TVL) * (Volume_24h / TVL)`.
- **Output:** Top N candidate pairs.

### B. Execution Engine ("The Executor")
Open positions with optimal bin configuration.
- **Strategies:** "Spot" (uniform) and "Curve" (concentrated).
- **Auto-balancing entry:** split deposit ~50/50 by USD, swapping via Jupiter (slippage < 1%).
- **DLMM:** read `activeId`, deposit within a bin range (e.g. ±10 bins from active).

### C. Risk & Position Monitor ("The Guardian")
Active management of open positions.
- **Rebalance trigger:** `activeId` leaves the deposited bin range → withdraw, re-balance 50/50,
  redeposit around the new `activeId`.
- **Emergency stop:** global stop-loss on USD drawdown; cap rebalances/hour to avoid fee bleed.

### D. Notifications & Control ("The Console")
Telegram bot for monitoring and control.
- Two-way: commands (`/scan`, `/top`, `/status`, `/config`, `/help`) + push alerts.
- Allowlist-gated; read/scan-only (no fund-moving commands exposed).

### E. Logger & Reporting
Track `initial_deposit_usd`, `current_value_usd`, `fees_collected_usd`, `net_profit`. Output to
console and SQLite.

## 4. Safety Constraints
- **Simulation mode:** `DRY_RUN=true` (default) simulates without sending transactions.
- **Slippage protection:** max slippage hard-clamped to 1% (100 bps) in code.
- **RPC usage:** retries for send/confirm.

## 5. Roadmap
- **Step 1 (done):** Scanner + project scaffold.
- **Telegram layer (done):** two-way bot + alerts.
- **Step 2 (done):** Jupiter swaps + DLMM Spot deposit/withdraw.
- **Step 3:** 60s monitor loop — rebalance on out-of-range, global stop-loss, rebalance cap.
- **Step 4:** Priority fees, send/confirm retries, cumulative fee logging.

---

## Implementation Status & Deviations

The bot is implemented through Step 2. Several endpoints in the original spec were **retired**
and corrected during implementation (verified against live APIs and SDK type definitions):

| Area | Original spec | Current reality (in use) |
| --- | --- | --- |
| Meteora pools | `dlmm-api.meteora.ag/pair/all` | `https://dlmm.datapi.meteora.ag/pools` (paginated, nested fields; 100k+ pools sorted largest-first → bounded `MAX_POOLS_SCAN`) |
| Jupiter swaps | Quote API V6 (`quote-api.jup.ag/v6`) | `https://api.jup.ag` `GET /swap/v1/quote`, `POST /swap/v1/swap`, with `x-api-key` |
| Jupiter prices | — | `GET /price/v3?ids=…` for USD valuation |
| DLMM SDK | `@meteora-ag/dlmm` (generic) | `@meteora-ag/dlmm` v1.9.x; `initializePositionAndAddLiquidityByStrategy` (Spot); new position Keypair co-signs |
| Persistence | "Local JSON or SQLite" | SQLite (`better-sqlite3`) with idempotent migrations |

**Built:** scanner, Telegram bot, Jupiter swapper, DLMM executor (enter/open/close).
**Pending:** monitor loop (Step 3), priority-fee/fee-accounting refinements (Step 4).

See `CLAUDE.md` for architecture and conventions; `README.md` for setup/usage.

## Changelog
- _baseline_ — Original spec imported into the repo; status & API deviations documented.
