# Architecture brief — Omon

*Written 2026-09-04. Deadline 2026-09-08 23:59 UTC. Solo build, ~28 hours left.*
*Theme on the submission form: **Payment Workflows**.*

## Summary

```text
Style:        modular monolith — one Next.js app, nothing else
Stack:        Next.js App Router (TS) + Postgres (Neon) + Drizzle + Vercel
Deploys:      1
Deployed at:  [set this in hour one, before writing features]
Network:      BSC testnet for payments. Binance Agentic sub-account for trading.
```

Omon is one system with two agents inside it. Both sell to **external** agents over
paid HTTP endpoints. One of them also trades.

- **Intel Agent** — turns news into structured market intelligence. Sells it at `/api/intel`.
- **Signal Agent** — takes that intel plus live Binance prices, produces a trade signal,
  sells it at `/api/signals`, and places the trade on the Binance Agentic sub-account.
- **Budget layer** — between the Signal Agent and Binance. Not an agent. Plain code.

Cut: the Treasury/yield agent. See "Cut list" for why the docs made this decision for us.

## The demo path

| # | Action | UI shows | Server does | Persists |
|---|---|---|---|---|
| 1 | Cron tick (or you click "ingest") | News item lands in the feed | Pull headlines → LLM → structured intel | `intel` |
| 2 | **In Claude Desktop:** "find crypto intel I can buy and buy it" | Split screen: Claude on the left, Omon console on the right | `GET /api/intel` returns **HTTP 402** with price + payTo | — |
| 3 | Claude signs and retries | **Payment lands. Balance moves on screen.** Intel is delivered | b402 facilitator verifies + settles USDT on BSC testnet | `purchases` |
| 4 | Omon continues on its own | Signal appears with its reasoning | Intel + MCP prices → LLM → structured signal | `signals` |
| 5 | — | Budget check passes, order goes out, **real Binance order id appears** | Budget layer allows → MCP `place order` on the sub-account | `actions` |
| 6 | Ask Claude to buy the signal too | Second payment lands | `GET /api/signals` → 402 → paid | `purchases` |
| 7 | Trigger an oversized trade | **BLOCKED** — budget refuses, nothing moves | Budget layer denies, logs reason | `actions` |

**Aha step: row 3.** A third-party agent you did not write pays your agent, live, on camera.
That row gets the fixture, the retry and the good error state. Nothing else does.

## Diagram

```text
   External agents                    You
   (Claude Desktop, Codex,             │
    anything in B402 Bazaar)           ▼
            │                    [Console]         src/app  — one screen, SSE
            │ HTTP 402 + pay          │
            ▼                         ▼
      [Paid endpoints]  ────────►  [API routes]     src/app/api
       /api/intel                     │
       /api/signals            ┌──────┼──────┐
            │                  ▼             ▼
            │            [Budget layer]  [Postgres]   src/lib/budget.ts
            │                  │
            └──────────────────┼─────────────┐
                               ▼             ▼
                          [Seams]        src/lib/*.ts  ← only files importing an SDK
                               │
             ┌─────────────┬───┴────────┬──────────────┐
             ▼             ▼            ▼              ▼
       Binance MCP    b402 facilitator  News API    LLM
```

Seven boxes. Every one is a folder in the repo or a URL you can open.

## Components

| Component | Tech | Responsibility | Depends on |
|---|---|---|---|
| Console | Next.js + Tailwind + shadcn, SSE | One screen: feed, payments, signals, budget, order log | `/api/stream` |
| Intel Agent | Route + LLM | Headlines → `{assets, direction, confidence, thesis}` | News seam, LLM seam |
| Signal Agent | Route + LLM | Intel + prices → `{symbol, side, size, thesis}` | MCP seam, LLM seam |
| Budget layer | Plain TS, no LLM | ALLOW / BLOCK / APPROVE on every trade and payout | Postgres |
| Paid endpoints | b402 middleware in route handlers | 402 → verify → serve | b402 seam |
| Execution | MCP seam | Places the spot order on the Agentic sub-account | Binance MCP |

## Data model

Four tables. Nothing else.

```text
intel      id, headline, source_url, summary, assets[], direction, confidence, created_at
signals    id, intel_id, symbol, side, size_usd, thesis, created_at
purchases  id, endpoint, buyer_addr, amount, token, tx_hash, created_at
actions    id, kind(trade|payout), payload, decision, reason, order_id, created_at
```

The budget ledger is **derived** from `actions` + `purchases`, not its own table.

## API surface

| Method | Path | Purpose | Returns |
|---|---|---|---|
| GET | `/api/intel` | **PAID (402)** — latest market intelligence | Intel JSON |
| GET | `/api/signals` | **PAID (402)** — latest trade signal | Signal JSON |
| POST | `/api/cron/ingest` | News → intel | `{ok}` |
| POST | `/api/cron/tick` | Intel + prices → signal → budget → trade | `{ok}` |
| GET | `/api/stream` | SSE feed for the console | event stream |
| GET | `/api/state` | Console cold load | Everything the screen needs |

Six. If you write a seventh, something grew without a decision.

## Shared types

```ts
// src/lib/types.ts — commit this FIRST, before any feature code.
export type Intel  = { id: string; headline: string; sourceUrl: string; summary: string;
                       assets: string[]; direction: "bullish"|"bearish"|"neutral";
                       confidence: number; createdAt: string };
export type Signal = { id: string; intelId: string; symbol: string; side: "BUY"|"SELL";
                       sizeUsd: number; thesis: string; createdAt: string };
export type Decision = { decision: "ALLOW"|"BLOCK"|"REQUIRE_APPROVAL"; reason: string;
                         remainingUsd: number };
export type Purchase = { id: string; endpoint: string; buyerAddr: string;
                         amount: string; token: string; txHash: string; createdAt: string };
```

## External dependencies and their seams

| Dependency | Used for | Fixture recorded? | If it dies on stage |
|---|---|---|---|
| `lib/binance-mcp.ts` | Balances, prices, place order | ☐ | Replay a recorded order response; say so |
| `lib/b402.ts` | 402 challenge, verify, settle | ☐ | Fall back to a plain USDT transfer between two wallets |
| `lib/news.ts` | Headlines | ☐ | Ship with 20 recorded headlines. Nobody can tell |
| `lib/llm.ts` | Intel + signal generation | ☐ | Recorded intel/signal pair for the exact demo story |

**`DEMO_MODE=fixture|auto|live`** — one env var, read in every seam. Verified on the
deployed URL before recording. ☐

## Timeout budget

```text
Host function limit:     Vercel Hobby ~10s (VERIFY on your plan before designing around it)
Longest operation:       /api/cron/tick — news + 2 LLM calls + MCP order ≈ 15-40s
Shape chosen:            cron route writes rows; console reads via SSE.
                         NEVER run the tick inside a user-facing request.
```

The paid endpoints must answer fast — they serve rows that already exist. Do not
generate intel inside `/api/intel`.

## Security boundaries

```text
Secrets live:            server only. Before demoing: grep -rl "sk-\|API_KEY\|SECRET" .next/static
Signing key held by:     backend env (the seller wallet that receives payments)
Agent authorization:     allowlist of symbols + hard USD cap + daily cap, enforced in
                         src/lib/budget.ts. The LLM never sees or sets a limit.
Network:                 BSC testnet for payments. Binance Agentic sub-account for trading,
                         funded small. Withdrawals to external addresses are blocked by
                         Binance itself — say this out loud when asked about safety.
```

## Build order

```text
TONIGHT     spike 1: MCP auth + read balance + one tiny spot order      ~90 min
TONIGHT     spike 2: return a 402 from a route, pay it from a script    ~90 min
TONIGHT     spike 3: Bazaar metadata blob indexes the endpoint          ~30 min, may slip

Hour 0-1    deploy an empty Next app to Vercel. A URL must exist tonight.
Hour 1-3    walking skeleton: hardcoded intel -> hardcoded signal -> REAL MCP order
Hour 3-8    THE AHA: /api/intel returns 402, Claude Desktop pays it, money moves
Hour 8-14   real news -> real intel -> real signal; /api/signals paid too
Hour 14-18  budget layer + the BLOCKED case
Hour 18-24  console + SSE, five states, error handling
Hour 24+    rehearse against production, record the fallback video
```

**Feature freeze at T-2h.** Checkpoint deploys at hours 3, 8, 16, 24.

## Risks

| Risk | Detected by | Fallback |
|---|---|---|
| Official Binance MCP has no demo/paper mode — user believes demo accounts are allowed, docs do not confirm it | Spike 1 tonight | Fund the Agentic sub-account with a tiny real amount ($20). Withdrawals are blocked by Binance, so exposure is capped |
| b402 seller side is harder than the docs suggest | Spike 2 tonight | Plain USDT transfer between two wallets. Still agent-to-agent. Drop the "402" wording |
| Bazaar indexing needs a mainnet settle, not testnet | Spike 3 | Skip Bazaar. Hand Claude Desktop the URL directly. The demo is unchanged |
| Tick exceeds function timeout in prod but not locally | Deploy at hour 1, not hour 20 | Cron + SSE is already the design. Do not retrofit |
| Nobody external buys during the video | — | You are the external buyer, via Claude Desktop. That is legitimate and it is the point |

## Cut list

Decided now, in daylight.

```text
1. Treasury / yield agent. The MCP scopes are market data, spot, margin, convert and
   futures. There is NO Earn or staking scope. It has no rail. It is not a scope cut,
   it is a "the platform does not do this" cut. Say so in the README as a roadmap line.
2. Reputation layer / track record. You cannot build a 30-day win rate in 4 days, and
   "67% (2 of 3)" is worse than nothing.
3. "Agent marketplace" framing. You have two endpoints, not a marketplace. Pitch the
   pipeline; let Bazaar be the marketplace.
4. Human approval flow. The BLOCK case carries the whole point on its own.
5. Futures and margin beyond the three orders Track B needs.
6. Auth, onboarding, landing page, multi-user, backtesting, Docker, tests beyond one
   smoke test of the demo path.
```

## Handoff

```text
demo.hero_screen — The console. Left: intel + signal feed. Right: money in (payments)
                   and money out (orders), with the budget number large and animated.
                   The moment a payment lands must be impossible to miss.
Next             — /skillz:frontend (hand it src/lib/types.ts), then /skillz:readme
```
