# Product Requirements: METEOR-FLOW v2.1 (AI-Enhanced LP Automator)

> Living PRD. Edit via a feature branch + PR (see `CONTRIBUTING.md`). Record notable changes in
> the [Changelog](#changelog).

## 1. Project Overview
Build a Node.js/TypeScript automated system to screen, execute, and manage Liquidity Provider
(LP) positions on Meteora DLMM (Dynamic Liquidity Market Maker) on Solana. The goal is
sustainable revenue through high fee capture while minimizing Impermanent Loss (IL).

**v2.0** adds an **AI Intelligence Layer** (via OpenRouter) that acts as a *Strategic Reasoning
Engine* — an "Investment Committee" that reviews Scout data and decides **tactics** (enter?,
strategy, bin width, confidence), while TypeScript code does the **heavy lifting** (execution,
gas, signatures, and the authoritative stop-loss). The LLM is **advisory** — it never holds keys
or sends transactions.

**v2.1** adds a **Supabase (PostgreSQL)** centralized data layer for cloud dashboards and safe,
centralized historical data — enabling continuous improvement — while keeping all secrets local
to the VPS.

## 2. Tech Stack
- **Runtime:** Node.js (v20+)
- **Language:** TypeScript (strict, ESM)
- **Blockchain:** `@solana/web3.js`, `@meteora-ag/dlmm`
- **Trading/Swaps:** Jupiter (`api.jup.ag`)
- **AI:** OpenRouter (Reasoning Bridge) — default model `anthropic/claude-opus-4.8`
- **Data:** Supabase (PostgreSQL) via `@supabase/supabase-js` for centralized analytics/logs;
  SQLite (`better-sqlite3`) as the local failover queue and offline buffer
- **Notifications/Control:** Telegram via grammY
- **Environment:** `.env` for private keys, RPC URLs, and API keys

## 3. Core Modules & Logic

### A. Market Scanner ("The Scout") — data collector
Identify high-yield, high-utilization pools and gather the data the Strategist reasons over.
- **Source:** Meteora DLMM data API (see §Deviations for the current endpoint).
- **Filters:** Min TVL > $10,000; Min Volume/TVL > 0.5; Bin Step 10–100; exclude
  blacklisted/unverified tokens.
- **Score:** `(24h_Fee / TVL) * (Volume_24h / TVL)`.
- **Output:** Top N candidate pairs, plus a derived **volatility index** per pool (see §5).

### B. The Strategist ("AI Layer") — reasoning engine
LLM (via OpenRouter) reviews the Scout's data and returns **JSON tactics**: a decision, strategy
type, bin-range width, and a confidence score. Advisory only. Details in §5.

### C. Execution Engine ("The Executor") — tactical
Open positions with the configuration the Strategist (or Safe Mode) selects.
- **Strategies:** Spot (uniform), Curve (concentrated), Bid-Ask.
- **Auto-balancing entry:** split deposit ~50/50 by USD, swapping via Jupiter (slippage < 1%).
- **DLMM:** read `activeId`, deposit within the chosen bin range (default ±10 bins from active).

### D. Risk & Position Monitor ("The Guardian") — risk management
Continuous monitoring with AI-assisted (but code-authoritative) decisions.
- **Rebalance trigger:** `activeId` leaves the deposited bin range → optionally consult the
  Strategist ("rebalance now vs wait for mean reversion"), then withdraw, re-balance 50/50,
  redeposit around the new `activeId`.
- **Emergency stop:** global stop-loss on USD drawdown; cap rebalances/hour to avoid fee bleed.
  **The stop-loss is pure code and always runs**, independent of AI or cloud availability.

### E. Notifications & Control ("The Console")
Telegram bot for monitoring and control.
- Two-way: commands (`/scan`, `/top`, `/status`, `/config`, `/help`) + push alerts (incl. AI
  decisions and rationale).
- Allowlist-gated; read/scan-only (no fund-moving commands exposed).

### F. Logger & Reporting
Track `initial_deposit_usd`, `current_value_usd`, `fees_collected_usd`, `net_profit`, AI
insights, and rebalance events. Written to the Supabase data layer (§6), with local SQLite as
the failover buffer; mirrored to console.

## 4. Safety Constraints
- **Simulation mode:** `DRY_RUN=true` (default) simulates without sending transactions.
- **Slippage protection:** max slippage hard-clamped to 1% (100 bps) in code.
- **RPC usage:** retries for send/confirm.
- **AI is advisory:** never holds keys, never signs. The Executor/Guardian act on validated JSON.
- **Safe Mode fallback:** if OpenRouter is down, slow (past `AI_TIMEOUT_MS`), over budget, or
  returns invalid JSON, the system falls back to hardcoded conservative rules (current scanner
  filters + Spot ±10 bins). The pure-code stop-loss runs regardless.
- **Zero-key storage:** `PRIVATE_KEY` / `RPC_URL` live only in the VPS `.env` and are **never**
  written to Supabase or any external store (see §6).
- **Cloud-independent operation:** trading and risk management never block on Supabase; failed
  writes are queued locally and replayed (see §6).

## 5. AI Intelligence Layer (OpenRouter)

### Reasoning Bridge
A future `src/services/aiService.ts` module calls OpenRouter's chat-completions API. All
responses are **requested and returned as JSON**, enforced via structured outputs
(`response_format: { type: "json_schema", … }`) on supported models, with a parse +
schema-validate + single-retry fallback otherwise. On any failure → **Safe Mode**.

- **Provider/model:** OpenRouter, default `anthropic/claude-opus-4.8` (strongest reasoning for
  the "Investment Committee" role; calls are per-scan / per-decision, not per-block, so cost is
  modest). Cheaper alternative: `anthropic/claude-sonnet-4.6`. Selectable via `OPENROUTER_MODEL`.
- **Cadence:** invoked per scan and at rebalance decision points — never in a hot loop.

### A. Market-Regime Classifier
The Scout sends a summary of the top ~10 pools; the AI categorizes the market (e.g.
"High-Vol Trending," "Low-Vol Sideways," "Toxic Arbitrage") and returns a **priority list**
with recommended bin strategies.

**Data payload (real fields we already fetch; no Birdeye):**
```json
{
  "pool": "SOL-USDC",
  "tvl": 1000000,
  "vol_24h": 500000,
  "fees_24h": 2000,
  "price_change_24h": -2.5,
  "volatility_index": 0.85,
  "bin_step": 20
}
```
`vol_24h`/`fees_24h` come from datapi `volume["24h"]`/`fees["24h"]`; `price_change_24h` from
Jupiter Price v3 `priceChange24h`. `volatility_index` is **derived** from these (e.g. normalized
|price_change| blended with the fee/TVL ratio) — no external OHLCV provider required.

### B. Dynamic Parameter Optimization
From `bin_step` + `volatility_index`, the AI decides:
- **Strategy:** Spot / Curve / Bid-Ask.
- **Range/width:** e.g. "deploy 40 bins wide to capture volatility" vs "concentrate 10 bins for
  max fee capture."

### C. Unified Decision Schema & Action Gate
Every Strategist call returns this canonical JSON (supersedes the v2.0 `riskLevel` form):
```json
{
  "decision": "ENTER | WAIT | EXIT | REBALANCE",
  "strategy": "SPOT | CURVE | BID_ASK",
  "bin_width": 20,
  "reasoning": "one concise sentence",
  "confidence_score": 0.0
}
```
**Action gate:** the bot acts only when `decision` is actionable (ENTER/REBALANCE/EXIT) **and**
`confidence_score > AI_MIN_CONFIDENCE` (default 0.7). `WAIT` is a no-op.

**Rebalance cost rule:** if estimated rebalance cost (gas + slippage) > **20%** of estimated
profit, the Strategist must return `WAIT` — preventing fee bleed during transient spikes /
"falling knife" moves. The pure-code stop-loss is unaffected and authoritative.

### D. Feedback Loop & Continuous Improvement
- **Per-trade:** after a position closes, send PnL + fee data to the AI for a concise
  "lesson learned," persisted to `ai_insights` (§6).
- **Backtesting loop:** periodically (e.g. weekly), the AI analyzes the centralized Supabase
  history to identify weaknesses (e.g. "we lose on memecoin pools at low liquidity") and the bot
  tightens parameters accordingly (e.g. raise `MIN_TVL_USD`). Centralized data makes this safe
  and repeatable.

### Config (documented; implemented in a later PR)
| Key | Default | Purpose |
| --- | --- | --- |
| `AI_ENABLED` | `false` | Master switch; off = pure-code Safe Mode |
| `OPENROUTER_API_KEY` | — | OpenRouter credential |
| `OPENROUTER_MODEL` | `anthropic/claude-opus-4.8` | Strategist model |
| `AI_MIN_CONFIDENCE` | `0.7` | Act only if `confidence_score` exceeds this |
| `AI_TIMEOUT_MS` | `15000` | Past this, fall back to Safe Mode |

## 6. Data Architecture & Security (Supabase)

**Why Supabase:** monitor the bot from anywhere via the Supabase dashboard (no SSH to the VPS);
relational links `positions → rebalance_logs → performance_metrics`; encrypted (SSL) transport
with API keys; centralized, durable history for the continuous-improvement loop (§5.D).

**Role:** Supabase is the **primary** store for analytics/log data. A **local failover queue**
(reuse the existing SQLite DB) buffers writes whenever Supabase is unreachable and replays them
on reconnect. Trading, risk management, and the stop-loss never block on the cloud DB.

**Zero-key storage:** `PRIVATE_KEY` and `RPC_URL` stay in the VPS `.env` only. Supabase stores
**only** non-secret operational data: transaction ids, P/L, AI reasoning, fee/position stats.

**Schema (PostgreSQL):**
- `positions` — `id` (UUID), `pair_address`, `entry_price`, `bin_range`, `strategy_type`,
  `initial_usd_value`, `status` (OPEN/CLOSED). (Extends today's SQLite `positions`.)
- `rebalance_logs` — `position_id` (FK), `old_bin_range`, `new_bin_range`, `gas_cost`,
  `swap_slippage`, `reasoning` (AI-provided).
- `performance_metrics` — `total_fees_collected`, `impermanent_loss`, `net_profit_usd`,
  `timestamp`.
- `ai_insights` — `position_id` (FK), `regime`, `decision`, `confidence_score`, `outcome_pnl`,
  `lesson`, `ts` (from the §5.D feedback loop).

**Config (documented; implemented in a later PR):**
| Key | Default | Purpose |
| --- | --- | --- |
| `SUPABASE_ENABLED` | `false` | Off = local SQLite only |
| `SUPABASE_URL` | — | Project URL |
| `SUPABASE_KEY` | — | Service-role key, **VPS-only**, never committed |

## 7. Roadmap

**Core track (pure code):**
- **Step 1 (done):** Scanner + project scaffold.
- **Telegram layer (done):** two-way bot + alerts.
- **Step 2 (done):** Jupiter swaps + DLMM Spot deposit/withdraw.
- **Step 3:** 60s monitor loop — rebalance on out-of-range, global stop-loss, rebalance cap.
  *(Prerequisite for AI-assisted rebalancing.)*
- **Step 4:** Priority fees, send/confirm retries, cumulative fee logging.

**v2.0 AI track:**
- **AI-1 (Brain):** OpenRouter entry-score / regime classification; advisory, Safe-Mode fallback.
- **AI-2 (Tactical):** AI-chosen strategy + bin width at deposit; confidence gate.
- **AI-3 (Reviewer):** post-trade feedback loop → `ai_insights`.

**v2.1 Infra track:**
- **DB-1:** `@supabase/supabase-js` connector + schema; sync layer for positions/metrics/logs.
- **DB-2:** local failover queue (SQLite) with replay-on-reconnect.
- **DB-3:** backtesting/continuous-improvement loop over Supabase history.

---

## Implementation Status & Deviations

The bot is implemented through Step 2 (core track). The AI and Supabase tracks are **spec-only**
so far. Several endpoints in the original spec were **retired** and corrected during
implementation (verified against live APIs and SDK type definitions):

| Area | Original spec | Current reality / target |
| --- | --- | --- |
| Meteora pools | `dlmm-api.meteora.ag/pair/all` | `https://dlmm.datapi.meteora.ag/pools` (paginated, nested fields; 100k+ pools sorted largest-first → bounded `MAX_POOLS_SCAN`) |
| Jupiter swaps | Quote API V6 (`quote-api.jup.ag/v6`) | `https://api.jup.ag` `GET /swap/v1/quote`, `POST /swap/v1/swap`, with `x-api-key` |
| Jupiter prices | — | `GET /price/v3?ids=…` for USD valuation |
| DLMM SDK | `@meteora-ag/dlmm` (generic) | `@meteora-ag/dlmm` v1.9.x; `initializePositionAndAddLiquidityByStrategy` (Spot); new position Keypair co-signs |
| Persistence | "Local JSON or SQLite" / SQLite-only | **Supabase (Postgres) primary + SQLite local failover queue** |
| Market data (v2 AI) | Birdeye OHLCV | Reuse existing: datapi volume buckets + Jupiter `priceChange24h` → derived volatility (no Birdeye) |
| AI model | `claude-3.5-sonnet` / `gemini-pro-1.5` | OpenRouter `anthropic/claude-opus-4.8` (default), `anthropic/claude-sonnet-4.6` (alt) |
| AI action gate | `riskLevel > 7` skip | Unified `decision` + `confidence_score > AI_MIN_CONFIDENCE` (0.7) |

**Built:** scanner, Telegram bot, Jupiter swapper, DLMM executor (enter/open/close).
**Pending:** monitor loop (Step 3); AI track (AI-1…AI-3); Supabase track (DB-1…DB-3); Step 4.

See `CLAUDE.md` for architecture and conventions; `README.md` for setup/usage.

## Appendix: Strategist System Prompt (draft)

Canonical (English) starter system prompt for `aiService.ts`. Refine during AI-1 implementation.

```text
You are an Algorithmic Liquidity Strategist specializing in Meteora DLMM on Solana. You
analyze pool data and decide the most profitable liquidity-provision strategy. You ADVISE
ONLY — code handles execution, gas, and signing.

Your goals, in priority order:
1. Maximize fee capture (yield).
2. Minimize Impermanent Loss (IL).
3. Avoid "toxic flow" — never rebalance into an asset that is actively crashing/dumping.

Decision logic:
- High volatility & unclear trend  -> "SPOT" strategy with a WIDE range.
- Clear uptrend (bullish)          -> "CURVE" strategy, concentrating liquidity upward.
- If estimated rebalance cost (gas + slippage) > 20% of estimated profit -> decision "WAIT".
- When data is ambiguous or a token looks like a "falling knife" (sharp negative
  price_change with rising volatility), prefer "WAIT" and explain why.

Input: JSON describing a pool (tvl, vol_24h, fees_24h, price_change_24h, volatility_index,
bin_step). Respond with ONLY this JSON object (no prose outside JSON):
{
  "decision": "ENTER" | "WAIT" | "EXIT" | "REBALANCE",
  "strategy": "SPOT" | "CURVE" | "BID_ASK",
  "bin_width": number,            // bins each side of active (e.g. 10 concentrated, 40 wide)
  "reasoning": "one concise sentence",
  "confidence_score": number      // 0.0 .. 1.0
}

Rules:
- The bot acts only if confidence_score > 0.7 and decision is actionable; otherwise it waits.
- Never invent fields or reference pools not present in the input.
```

## Changelog
- **v2.1** — Supabase (PostgreSQL) centralized data layer added: primary analytics store with a
  local SQLite failover queue, zero-key storage, and `positions`/`rebalance_logs`/
  `performance_metrics`/`ai_insights` schema. Unified the AI output on a `decision` +
  `confidence_score` schema (confidence gate replaces `riskLevel`); refined the Strategist
  system prompt (English canonical) with toxic-flow / rebalance-cost guardrails.
- **v2.0** — AI Intelligence Layer (OpenRouter) added to the PRD: Strategist module, regime
  classifier, dynamic params, AI-assisted rebalance, feedback loop, and a draft system prompt.
  Harmonized stale references (datapi endpoint, `anthropic/claude-opus-4.8` model); dropped
  Birdeye in favor of existing data sources.
- _baseline_ — Original spec imported into the repo; status & API deviations documented.
