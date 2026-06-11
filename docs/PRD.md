# Product Requirements: METEOR-FLOW v2.0 (AI-Enhanced LP Automator)

> Living PRD. Edit via a feature branch + PR (see `CONTRIBUTING.md`). Record notable changes in
> the [Changelog](#changelog).

## 1. Project Overview
Build a Node.js/TypeScript automated system to screen, execute, and manage Liquidity Provider
(LP) positions on Meteora DLMM (Dynamic Liquidity Market Maker) on Solana. The goal is
sustainable revenue through high fee capture while minimizing Impermanent Loss (IL).

**v2.0** adds an **AI Intelligence Layer** (via OpenRouter) that acts as a *Strategic Reasoning
Engine* — an "Investment Committee" that reviews Scout data and decides **tactics** (enter?,
strategy, bin width, risk), while TypeScript code does the **heavy lifting** (execution, gas,
signatures, and the authoritative stop-loss). The LLM is **advisory** — it never holds keys or
sends transactions.

## 2. Tech Stack
- **Runtime:** Node.js (v20+)
- **Language:** TypeScript (strict, ESM)
- **Blockchain:** `@solana/web3.js`, `@meteora-ag/dlmm`
- **Trading/Swaps:** Jupiter (`api.jup.ag`)
- **Data:** Axios; Meteora data API; Jupiter Price API
- **AI:** OpenRouter (Reasoning Bridge) — default model `anthropic/claude-opus-4.8`
- **State:** SQLite (`better-sqlite3`) for position/performance/AI-insight tracking
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
LLM (via OpenRouter) reviews the Scout's data and returns **JSON tactics**: whether to enter,
strategy type, bin-range width, and a risk score. Advisory only. Details in §5.

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
  **The stop-loss is pure code and always runs**, independent of AI availability.

### E. Notifications & Control ("The Console")
Telegram bot for monitoring and control.
- Two-way: commands (`/scan`, `/top`, `/status`, `/config`, `/help`) + push alerts (incl. AI
  decisions and rationale).
- Allowlist-gated; read/scan-only (no fund-moving commands exposed).

### F. Logger & Reporting
Track `initial_deposit_usd`, `current_value_usd`, `fees_collected_usd`, `net_profit`, and AI
insights. Output to console and SQLite.

## 4. Safety Constraints
- **Simulation mode:** `DRY_RUN=true` (default) simulates without sending transactions.
- **Slippage protection:** max slippage hard-clamped to 1% (100 bps) in code.
- **RPC usage:** retries for send/confirm.
- **AI is advisory:** never holds keys, never signs. The Executor/Guardian act on validated JSON.
- **Safe Mode fallback:** if OpenRouter is down, slow (past `AI_TIMEOUT_MS`), over budget, or
  returns invalid JSON, the system falls back to the hardcoded conservative rules (current
  scanner filters + Spot ±10 bins). The pure-code stop-loss runs regardless.

## 5. AI Intelligence Layer (OpenRouter)

### Reasoning Bridge
A future `src/services/aiService.ts` module calls OpenRouter's chat-completions API. All
responses are **requested and returned as JSON**, enforced via structured outputs
(`response_format: { type: "json_schema", … }`) on supported models, with a parse +
schema-validate + single-retry fallback otherwise. On any failure → **Safe Mode**.

- **Provider/model:** OpenRouter, default `anthropic/claude-opus-4.8` (strongest reasoning for
  the "Investment Committee" role; calls are per-scan, not per-block, so cost is modest).
  Cheaper alternative: `anthropic/claude-sonnet-4.6`. Selectable via `OPENROUTER_MODEL`.
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

### C. AI-Assisted Rebalance
On out-of-range, the Guardian asks the Strategist whether to rebalance now or wait for mean
reversion — avoiding fee bleed during transient spikes / "falling knife" moves. The pure-code
stop-loss is unaffected and authoritative.

### D. Feedback Loop (Reviewer)
After a position closes, the system sends PnL + fee data to the AI for a concise "lesson
learned," persisted to a future SQLite `ai_insights` table (`position_id`, `regime`, `decision`,
`outcome_pnl`, `lesson`, `ts`) and used to inform future runs.

### Config (documented; implemented in a later PR)
| Key | Default | Purpose |
| --- | --- | --- |
| `AI_ENABLED` | `false` | Master switch; off = pure-code Safe Mode |
| `OPENROUTER_API_KEY` | — | OpenRouter credential |
| `OPENROUTER_MODEL` | `anthropic/claude-opus-4.8` | Strategist model |
| `AI_MAX_RISK` | `7` | Skip a pool if AI risk level > this |
| `AI_TIMEOUT_MS` | `15000` | Past this, fall back to Safe Mode |

## 6. Roadmap

**Core track (pure code):**
- **Step 1 (done):** Scanner + project scaffold.
- **Telegram layer (done):** two-way bot + alerts.
- **Step 2 (done):** Jupiter swaps + DLMM Spot deposit/withdraw.
- **Step 3:** 60s monitor loop — rebalance on out-of-range, global stop-loss, rebalance cap.
  *(Prerequisite for AI-assisted rebalancing.)*
- **Step 4:** Priority fees, send/confirm retries, cumulative fee logging.

**v2.0 AI track (layered on the core):**
- **AI-1 (Brain):** OpenRouter entry-score / regime classification on scanned pools; advisory,
  with Safe-Mode fallback.
- **AI-2 (Tactical):** AI-chosen strategy + bin width at deposit time.
- **AI-3 (Reviewer):** post-trade feedback loop → `ai_insights`.

---

## Implementation Status & Deviations

The bot is implemented through Step 2 (core track). The AI track is **spec-only** so far.
Several endpoints in the original spec were **retired** and corrected during implementation
(verified against live APIs and SDK type definitions):

| Area | Original spec | Current reality (in use) |
| --- | --- | --- |
| Meteora pools | `dlmm-api.meteora.ag/pair/all` | `https://dlmm.datapi.meteora.ag/pools` (paginated, nested fields; 100k+ pools sorted largest-first → bounded `MAX_POOLS_SCAN`) |
| Jupiter swaps | Quote API V6 (`quote-api.jup.ag/v6`) | `https://api.jup.ag` `GET /swap/v1/quote`, `POST /swap/v1/swap`, with `x-api-key` |
| Jupiter prices | — | `GET /price/v3?ids=…` for USD valuation |
| DLMM SDK | `@meteora-ag/dlmm` (generic) | `@meteora-ag/dlmm` v1.9.x; `initializePositionAndAddLiquidityByStrategy` (Spot); new position Keypair co-signs |
| Persistence | "Local JSON or SQLite" | SQLite (`better-sqlite3`) with idempotent migrations |
| Market data (v2 AI) | Birdeye OHLCV | Reuse existing: datapi volume buckets + Jupiter `priceChange24h` → derived volatility (no Birdeye) |
| AI model (v2) | `claude-3.5-sonnet` / `gemini-pro-1.5` | OpenRouter `anthropic/claude-opus-4.8` (default), `anthropic/claude-sonnet-4.6` (alt) |

**Built:** scanner, Telegram bot, Jupiter swapper, DLMM executor (enter/open/close).
**Pending:** monitor loop (Step 3); AI track (AI-1…AI-3); priority-fee/fee-accounting (Step 4).

See `CLAUDE.md` for architecture and conventions; `README.md` for setup/usage.

## Appendix: Strategist System Prompt (draft)

Starter system prompt for `aiService.ts`. Refine during AI-1 implementation.

```text
You are a professional DeFi liquidity provider specializing in Meteora DLMM on Solana.
You act as an Investment Committee: you do NOT execute trades — you advise. Code handles
execution, gas, and signing.

Given JSON describing candidate pools (tvl, vol_24h, fees_24h, price_change_24h,
volatility_index, bin_step), decide tactics for each pool. Be conservative by default:
when data is ambiguous or a token looks like a "falling knife" (sharp negative
price_change with rising volatility), prefer NOT entering and say why.

Respond with ONLY a JSON object matching this schema (no prose outside JSON):
{
  "regime": "high_vol_trending" | "low_vol_sideways" | "toxic_arbitrage" | "uncertain",
  "decisions": [
    {
      "pool": string,               // pool name, echoed from input
      "enter": boolean,
      "strategy": "Spot" | "Curve" | "BidAsk",
      "binWidth": integer,          // bins each side of active (e.g. 10 concentrated, 40 wide)
      "riskLevel": integer,         // 1 (safe) .. 10 (toxic)
      "rationale": string           // one concise sentence
    }
  ]
}

Rules:
- If riskLevel > 7, set enter=false.
- Wider bins for higher volatility (capture range); tighter bins for low-vol sideways
  (max fee density).
- Never invent fields or pools not present in the input.
```

## Changelog
- **v2.0** — AI Intelligence Layer (OpenRouter) added to the PRD: Strategist module, regime
  classifier, dynamic params, AI-assisted rebalance, feedback loop, and a draft system prompt.
  Harmonized stale references (datapi endpoint, `anthropic/claude-opus-4.8` model); dropped
  Birdeye in favor of existing data sources.
- _baseline_ — Original spec imported into the repo; status & API deviations documented.
