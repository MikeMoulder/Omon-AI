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

---

## 3. Binance Agent OS: seven surfaces

This is what the hackathon is about, so it is the longest part of this document, and every
claim in it ends at a file path you can open or a URL you can curl.

**Agent OS is not a logo on this project. It is the data path.** Seven Binance surfaces are
wired in. They carry every market read the strategy runs on, every order the agent places,
the payment rail it can bill on, the discovery document other agents find it through, and
the protocol it both speaks and serves.

### 3.1 The seven surfaces

| # | Agent OS surface | What Omon does with it | Where in the code |
|---|---|---|---|
| 1 | **Binance MCP Server** `agent.binance.com/mcp/agentic` | Full hand-rolled MCP client: `spot_tickerPrice`, `spot_klines`, `spot_getAccount`. OAuth 2.1 + PKCE + CIMD, complete | [`src/lib/mcp.ts`](src/lib/mcp.ts) · 563 lines |
| 2 | **Binance Skill Hub** `binance-cli 2.1.1` | `spot ticker-price`, `spot klines` — the candles the entire strategy computes on, batched 3.3× | [`src/lib/skillhub.ts`](src/lib/skillhub.ts) |
| 3 | **Binance Exchange API**, Spot Demo Mode | Order execution, balances, exchange filters. **39 fills** | [`src/lib/exchange.ts`](src/lib/exchange.ts) |
| 4 | **Binance USDⓈ-M Futures** | Perpetuals, leverage, signed positions, `reduceOnly` closes. **15 fills** | [`src/lib/futures.ts`](src/lib/futures.ts) · 710 lines |
| 5 | **Binance Pay / OnchainPay — B402** `@bnb-chain/b402` | The BSC payment rail, mapped against the vendor SDK, published, **25 assertions** | [`src/lib/b402.ts`](src/lib/b402.ts) |
| 6 | **Agent OS discovery conventions** | Publishing, machine-readably, which surface served every single read | [`src/lib/service.ts`](src/lib/service.ts) |
| 7 | **MCP — as a server** | Omon serving **its own six tools** to other agents over the same protocol it reads Binance with. Two of them paid | [`src/lib/mcp-server.ts`](src/lib/mcp-server.ts) |

Surface 7 is the one that changes what this project *is*. Everything from 1 to 6 makes Omon
an Agent OS **consumer**. Serving MCP makes it something other agents can **build on** —
which is the direction the platform is actually pointing, and it is the difference between
using a platform and extending it.

### 3.2 The three-rail read stack

Market reads in Omon are not wired to one vendor call. They are a **stack of three
independent rails, tried in strict order, with every fall-through recorded and published**.

```ts
// src/lib/exchange.ts — getPrices() and getCandles(), simplified
if (mcpEnabled()) {
  try   { ...; noteMcpUse("prices", { via: "mcp", tool: "spot_tickerPrice" }); return }
  catch { noteMcpUse("prices", { via: "rest", reason: String(err) }) }
}
if (cliEnabled()) {
  try   { ...; noteMcpUse("prices", { via: "cli", tool: "spot ticker-price" }); return }
  catch { noteMcpUse("prices", { via: "rest", reason: String(err) }) }
}
noteMcpUse("prices", { via: "rest", reason: `${mcpOffReason()}; ${cliMode().reason}` });
```

| Rail | Surface | Credentials needed | Role |
|---|---|---|---|
| 1 | Binance MCP Server | OAuth 2.1 | Preferred. Takes over the read stack the moment a token exists, with no other code change |
| 2 | Binance Skill Hub CLI | **None** for market data | Serving today, on the deployed origin, right now |
| 3 | Plain REST + HMAC | Demo Mode keys | The floor. Keeps the heartbeat alive if both rails above are down |

**`noteMcpUse()` is the load-bearing part of that design, not the fallback.** A silent
fallback is an integration that has quietly stopped existing, and it is the single most
common way a hackathon "integration" turns out to be a dead import nobody re-checked after
day one.

So every read in this system stamps `via: "mcp" | "cli" | "rest"` plus a reason;
[`GET /api/agent-os`](https://www.omon-ai.duckdns.org/api/agent-os) publishes that stamp
live; the console draws it as a status pill with the mode written on it in words; and two
smoke scripts **fail on purpose** if the data turns out to have arrived over plain REST:

```bash
npx tsx scripts/skillhub-smoke.ts --verbose   # PASS only if an Agent OS rail served it
npx tsx scripts/mcp-smoke.ts --verbose        # fails loudly on a silent REST fallback
```

Very few projects can tell you which rail served a given number. This one tells you on
every request, forever, without being asked.
