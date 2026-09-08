# Omon

**An autonomous trading agent that runs on Binance Agent OS, executes on two live Binance
venues, serves its own MCP server to other agents, and sells what it learns behind a real
HTTP 402 — on both the open x402 rail and Binance's own B402 rail.**

[Live console](https://www.omon-ai.duckdns.org) · [Machine-readable manifest](https://www.omon-ai.duckdns.org/.well-known/x402) · [Agent OS status, live](https://www.omon-ai.duckdns.org/api/agent-os) · [MCP endpoint](https://www.omon-ai.duckdns.org/api/mcp) · [B402 rail](https://www.omon-ai.duckdns.org/api/b402)

Built for the **Binance Agent OS Mini Hackathon**, Track A.

Omon is not a demo with a Binance logo on it. It is a running economic loop: it reads
Binance markets through Agent OS, forms a view with two model-driven agents, routes that
view through a thirteen-check deterministic gate with no model in it, executes on Binance
Spot Demo Mode and Binance USDⓈ-M Futures, books the fills into a durable ledger that
survives `SIGKILL`, derives real P&L from real fill prices — and then **sells the analysis
it just produced to other agents on the internet, for money, over an open standard, with
no account and no API key.**

It has been running unattended, every five minutes, on a public origin, for days.

---

## The scoreboard

Every number below is read out of this repo's durable ledger at
[`data/`](data/) and reproducible with one command. Nothing here is projected, rounded up,
or aspirational.

| | |
|---|---|
| **Orders filled on live Binance matching engines** | **54** |
| **Notional actually executed** | **$2,194.42** |
| **Trade decisions run through the budget gate** | **241** |
| **…of which the gate refused** | **159** (66%) |
| **Venues traded** | 2 — Binance Spot Demo Mode + USDⓈ-M Futures |
| **On-chain payments settled to the agent, for its analysis** | **14** |
| **Payment rails implemented** | **2** — x402 (Base Sepolia) and B402 (BNB Smart Chain) |
| **MCP implementations shipped** | **2** — Omon as MCP *client*, Omon as MCP *server* |
| **Binance Agent OS surfaces wired in** | **7** |
| **Offline assertions, deterministic, zero network** | **154** |
| **Live smoke checks against the deployed origin** | **77** |
| **Lines of TypeScript, application** | **10,968** |
| **Lines of TypeScript, tests and probes** | **4,202** |
| **Real money spent to build or run any of it** | **$0** |

That last row is the thesis. Every rail in this project was chosen because an unaffiliated
individual developer can reach it — no business entity, no funded account, no waiting on
anyone's approval. The result still executes against real matching engines and still takes
real on-chain payment.

```bash
npx tsx scripts/budget-test.ts && npx tsx scripts/pnl-test.ts && \
npx tsx scripts/exits-test.ts && npx tsx scripts/b402-test.ts && \
npx tsx scripts/futures-test.ts && npx tsx scripts/store-test.ts
# 154 assertions. No network, no credentials, no clock.
```

---

## Contents

| # | Section | What is in it |
|---|---|---|
| 1 | [The problem](#1-the-problem) | Why every agent at every hackathon is a cost centre |
| 2 | [What we built](#2-what-we-built) | The whole system on one screen |
| 3 | [Binance Agent OS: seven surfaces](#3-binance-agent-os-seven-surfaces) | **The main event** |
| 4 | [MCP, implemented in both directions](#4-mcp-implemented-in-both-directions) | Client *and* server. The deepest section |
| 5 | [The Skill Hub rail](#5-the-skill-hub-rail-and-the-traps-inside-it) | And the four traps inside it |
| 6 | [Execution: spot and perpetuals](#6-execution-spot-and-perpetuals) | Two venues, two seams, real fills |
| 7 | [The beat, end to end](#7-the-beat-end-to-end) | Ten numbered steps, every five minutes |
| 8 | [Knowing when to sell](#8-knowing-when-to-sell) | Exits, in code, with no model in them |
| 9 | [The budget layer](#9-the-budget-layer-thirteen-checks-no-model) | Thirteen checks. No model. No network |
| 10 | [Getting paid: x402 **and** B402](#10-getting-paid-x402-and-b402) | Both rails, both implemented |
| 11 | [Engineering highlights](#11-engineering-highlights-the-five-bugs-worth-your-time) | The five bugs worth your time |
| 12 | [Quick start](#12-quick-start) | Works on a stranger's machine |
| 13 | [Verify every claim](#13-verify-every-claim-on-this-page) | One command per claim |
| 14 | [Repo map](#14-repo-map) | Where everything lives |
| 15 | [Where this goes](#15-where-this-goes) | The economic object this is a datapoint for |

---

## 1. The problem

An agent that trades needs three things: market data it can trust, a venue that will
execute, and money.

Binance Agent OS now answers the first two properly. Nothing answers the third. An
autonomous agent has no way to **earn**, so every agent at every hackathon on earth is the
same economic object: **a cost centre with a private key**, burning down a balance some
human topped up, producing analysis that dies in a log file the moment the demo ends.

Omon inverts that. It reads Binance markets through Agent OS, forms a view, trades that
view on real matching engines, and then **sells the view it just formed** — to any other
agent on the internet, for one cent, over an open protocol, with no account, no API key,
no signup form and no human in the loop on either side.

The analysis is not the by-product of the trading. **The analysis is the second product.**
The same conviction score that sizes Omon's own position is the thing another agent pays
for, and the payment lands on chain in the same beat.

---

## 2. What we built

One process. Two model-driven agents. Two Binance execution venues. Two payment rails. Two
MCP implementations pointing in opposite directions. And one layer of plain, deterministic,
model-free code standing between all of it and money.

```
                     ┌──────────────────────────────────────────────┐
   RSS headlines ───►│  INTEL AGENT   (Gemini, structured output)   │
   (no key, no       │  headline ──► {assets, direction, confidence,│
    signup)          │                thesis}                       │
                     └───────────────────┬──────────────────────────┘
                                         │
   BINANCE AGENT OS                      ▼
   ┌──────────────────────────┐   ┌──────────────────────────────────────┐
   │ 1. MCP    spot_klines    │──►│  SIGNAL AGENT  (Gemini + technicals) │
   │ 2. Skill Hub  binance-cli│   │  news + chart ──► conviction ──►     │
   │ 3. REST + HMAC (floor)   │   │  sized, venue-routed trade           │
   └──────────────────────────┘   └───────────────────┬──────────────────┘
        every read stamped                            │
        with the rail that                            ▼
        served it            ┌──────────────────────────────────────────┐
                             │  THE BUDGET GATE                         │
                             │  13 checks · no model · no network       │
                             │  53 assertions · full trace on every row │
                             │  ALLOW / BLOCK / REQUIRE_APPROVAL        │
                             └───────────────────┬──────────────────────┘
                                                 │ ALLOW only
                     ┌───────────────────────────┴───────────────┐
                     ▼                                           ▼
        BINANCE SPOT DEMO MODE                   BINANCE USDⓈ-M FUTURES
        real engine · real order ids             perps · signed positions
        39 fills                                 reduceOnly · 15 fills
                     │                                           │
                     └──────────────► FILL LEDGER ◄──────────────┘
                                  append-only · survives SIGKILL
                                           │
                     ┌─────────────────────┼─────────────────────┐
                     ▼                     ▼                     ▼
              P&L from real        EXITS: stop, target,     THE CONSOLE
              fill prices          time-stop, in code       SSE, every 2s
                                           │
                                           ▼
          ┌────────────────────────────────────────────────────────────┐
          │  OMON SELLS ITS OWN ANALYSIS                               │
          │  · HTTP  402 at /api/intel and /api/signals                │
          │  · MCP   6 tools at /api/mcp, 2 of them paid via -32002    │
          │  · RAILS x402 on Base Sepolia  +  B402 on BNB Smart Chain  │
          │  · DISCOVERY /.well-known/x402, no directory needed        │
          └────────────────────────────────────────────────────────────┘
```

Every box above is running unattended on a public origin as you read this. The console
draws a live countdown to the next beat, so nobody has to take that on faith.
