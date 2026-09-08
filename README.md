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

---

## 4. MCP, implemented in both directions

Most projects that mention MCP have installed a client someone else wrote. **Omon
implements the protocol twice, from scratch, pointing in opposite directions** — as a
client that consumes Binance Agent OS, and as a server that other agents consume.

Both implementations are hand-rolled. No MCP SDK on either side. The wire format is small
enough to read, and one dependency fewer is one dependency fewer.

### 4.1 Omon as an MCP client — `src/lib/mcp.ts`, 563 lines

A complete Streamable-HTTP MCP client, written against the spec rather than a library.

| Piece | What was built |
|---|---|
| **Transport** | Streamable HTTP. JSON-RPC over `POST`, with the server free to answer `application/json` **or** `text/event-stream`. **Both framings parsed**, because a client that speaks only one does not survive contact with a real server |
| **Protocol version** | `2025-06-18`, negotiated in the handshake |
| **Handshake** | `initialize` → `notifications/initialized` → `tools/list` → `tools/call`, full lifecycle |
| **Tool resolution** | Name candidates tried in order (`spot_klines`, then `spot.klines`) because naming differs by exposure, then cached. [`resolveTool()`](src/lib/mcp.ts) |
| **Auth** | **OAuth 2.1, authorization code + PKCE**, with a loopback redirect listener and full discovery of `/.well-known/oauth-authorization-server`. [`scripts/mcp-auth.ts`](scripts/mcp-auth.ts) |
| **Client identity** | **`client_id_metadata_document`.** Omon publishes its own OAuth client metadata document at [`/.well-known/oauth-client`](https://www.omon-ai.duckdns.org/.well-known/oauth-client), and **that URL *is* its `client_id`** — the newest identity mechanism in the OAuth 2.1 agentic profile, implemented by hand |
| **Token lifecycle** | `.mcp-token.json`, gitignored, mode `600`, health-reported without ever exposing the token, renewable in place by the long-lived process |
| **Health surface** | `mcpMode()`, `tokenHealth()`, `mcpHealth()`, `mcpUsage()` — every one of them published at `/api/agent-os` |
| **Write path** | **Deliberately absent. See below** |

**The read/write split is a safety property, not a preference — and it is the single most
important design decision in this repo.**

An MCP token authorises the operator's *real* Binance account, with `canTrade: true`. An
order placed over that connection would spend real money. So [`src/lib/mcp.ts`](src/lib/mcp.ts)
**has no write path at all**, and its file header forbids adding one. Orders go to a
completely different host, with a completely different key pair, holding no real funds.

Agent OS handed us a rail powerful enough that the correct engineering response was to
refuse to use half of it. Most projects would have wired the trade path straight through
because it was the shortest line on the diagram.

**The full auth flow is implemented end to end and demonstrably reaches Binance's own
consent screen** — Binance fetches Omon's client metadata document from the public origin,
renders the "Agentic Account Access" screen with the operator's account and an agentic-
account picker, and PKCE, the redirect, the metadata document and the base URL are all
correct on our side. The client sits ahead of the Skill Hub in the read stack and takes
over the moment a token lands, with **no other change to any file**:

```bash
npx tsx scripts/mcp-auth.ts       # full OAuth 2.1 + PKCE + CIMD flow, loopback redirect
npx tsx scripts/mcp-smoke.ts -v   # handshake, tools/list, tools/call, framing, fallback detection
```

### 4.2 Omon as an MCP server — `src/lib/mcp-server.ts`, live at `/api/mcp`

Omon reads Binance over one MCP connection and **publishes its own conclusions over
another**. Six tools, live, right now, on the public origin:

```bash
curl -s -X POST https://www.omon-ai.duckdns.org/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

| Tool | Price | What it returns |
|---|---|---|
| `omon_rails` | **free** | Which Binance surface served each of the last reads, plus which Binance products are reachable at all without a funded production account |
| `omon_pnl` | **free** | Realised and unrealised profit, split by venue, folded from the durable fill ledger |
| `omon_positions` | **free** | Open spot holdings and perp positions, with cost basis, live mark and open profit |
| `omon_gate` | **free** | Recent gate decisions with the full thirteen-check trace, and exactly which check refused |
| `omon_intel` | **$0.01** | The Intel Agent's structured read of live market news |
| `omon_signal` | **$0.01** | The Signal Agent's conviction, size and thesis |

**Because two of those tools are paid, this is a business rather than a demo.** It is,
as far as we can tell, one of the very few MCP servers anywhere that will bill you.

**Four of six are free on purpose.** Gating everything would make the best feature
undemonstrable — someone with no wallet could not call the server at all. The four tools
that describe what the agent *is* answer to anyone. The two that carry the analysis it
sells are the product.

**Two design decisions worth naming:**

1. **MCP has no concept of paying for a tool call, so we built one.** The 402 rides inside
   the JSON-RPC error envelope: an unpaid call to a paid tool returns code **`-32002`**
   carrying the full x402 challenge *and* the same redacted preview the HTTP route serves,
   so a buying agent can judge the product before it spends anything. Resend with an
   `X-PAYMENT` header to collect. That code is Omon's own choice from the
   implementation-defined range, and it is documented here rather than left to be
   reverse-engineered out of a number.
2. **The paid tools proxy their own HTTP routes rather than reimplementing settlement.**
   `omon_intel` self-fetches `/api/intel` over loopback with the caller's payment header
   attached. Settlement, the challenge, the redaction and the purchase log already exist
   there, correct and tested — and a second implementation inside the MCP layer would be a
   second thing that can disagree about whether someone paid. It also means **a purchase
   made over MCP lands in the same `data/payments.jsonl` as one made over HTTP**, with no
   extra wiring, because it is the same sale.

Both response framings are served, `application/json` and `text/event-stream`, because
[`src/lib/mcp.ts`](src/lib/mcp.ts) parses both and a server that spoke only one would not
survive contact with the other half of this codebase.

```bash
npx tsx scripts/mcp-server-smoke.ts --base https://www.omon-ai.duckdns.org --verbose
# 32 checks: handshake, six tools, four free tools returning real data,
# both paid tools refusing with -32002 and a full challenge, SSE framing, error codes
```

### 4.3 Why both directions matter

An agent that only consumes a platform is a user of that platform. An agent that consumes
it **and** re-serves what it learned over the same protocol is a **node in it**. The buying
agent on the other end of `/api/mcp` never touches Binance, never holds a key, and never
runs an indicator — it pays one cent and receives a conviction score computed on Binance
Agent OS candles. That is the platform compounding, and it is the whole reason MCP is worth
implementing twice.

---

## 5. The Skill Hub rail, and the traps inside it

[`binance-cli`](https://github.com/binance/binance-cli), the Skill Hub CLI, is official
Binance, needs **no credentials whatsoever** for market data, and is the rail an
unaffiliated developer can actually reach. Installed on the box as `binance-cli 2.1.1`,
from the official release tarball, **sha256-verified against the published checksum**
rather than piping an installer script into a root shell.

```bash
binance-cli spot ticker-price --symbol BNBUSDT
# {"symbol":"BNBUSDT","price":"773.76000000"}

binance-cli spot klines --symbol BTCUSDT --interval 1h --limit 200
# the identical array-of-arrays shape /api/v3/klines returns
```

That last property is why this rail took hours and not days: **the Skill Hub returns the
same candle shape as the REST endpoint**, so `decodeKlines()` parsed it unchanged and the
new rail dropped into an existing seam instead of forcing a rewrite. The seam discipline
from day one paid for itself the first day it was tested.

**Four engineering findings in [`src/lib/skillhub.ts`](src/lib/skillhub.ts) worth naming**,
because each one costs an unwarned developer about an hour:

| Finding | Why it matters |
|---|---|
| **`spawn` with `stdio: ["ignore","pipe","pipe"]`, never `exec`** | `exec` and `execFile` leave the child's stdin an open unwritten pipe, and `binance-cli` **blocks reading it**. The process hangs forever, with no output and no error. Nothing in the docs warns you |
| **Binary resolution cached, with a 30s miss TTL** | `cliMode()` is read on every price call, so stat-ing `PATH` each time is pure waste — but caching the *miss* permanently would mean a CLI installed while the process runs needs a restart to be noticed. The TTL is the deliberate compromise |
| **Batched reads: 3.3× measured** | `--symbols` fails in every documented form; `--json '{"symbols":[...]}'` works. On this rail the cost is process spawn, not network, so batching is real wall-clock time: **three symbols, 1.96s looped versus 0.60s batched** |
| **The `-1100` trap has two causes and one message** | Mapped in full below |

**The `symbols` trap, fully reverse-engineered**, because the error message actively lies
about its cause. Binance's server-side regex is a Java character-class intersection that
reads "word characters EXCEPT lowercase":

```text
["BTCUSDT","BNBUSDT"]      OK
["BTCUSDT", "BNBUSDT"]     -1100  Illegal characters   <- ONE SPACE after the comma
["btcusdt","bnbusdt"]      -1100  Illegal characters   <- lowercase. IDENTICAL error
```

Two completely different causes, one indistinguishable message. `cliPrices()` upper-cases
defensively for exactly that reason. **The same trap then behaves differently on each of
the three rails**, and it is mapped per rail in the code comments — on the MCP rail
batching is *impossible*, because the MCP layer serialises the array itself and inserts the
fatal space, so that rail must loop one symbol per call.

**What this rail makes true:** the OHLCV candles that
[`src/lib/indicators.ts`](src/lib/indicators.ts) and
[`src/lib/strategy.ts`](src/lib/strategy.ts) compute EMA, ATR, RSI and breakout structure
on are fetched **through Binance Agent OS, for real, with no token, on the deployed origin,
right now** — and `/api/agent-os` will tell you so on request.

### 5.1 What the Agent OS data actually does

Agent OS is not decorating a price label on a screen here. The `spot_klines` payload is the
direct input to a real technical engine:

| Layer | File | What it computes |
|---|---|---|
| Indicators | [`src/lib/indicators.ts`](src/lib/indicators.ts) | EMA, ATR, RSI, prior range. Pure math, no network, no state |
| Strategy | [`src/lib/strategy.ts`](src/lib/strategy.ts) | Trend regime, breakout structure, and a **conviction score** measuring how far the news and the chart agree |
| Signal | [`src/lib/llm.ts`](src/lib/llm.ts) | The Signal Agent, handed both halves, sizes the trade inside the true ceiling |

The indicator port is **cross-checked against the reference implementation bar for bar over
19,980 bars** by [`scripts/indicators-test.ts`](scripts/indicators-test.ts). Not spot-checked
— every bar.

A conviction line from a live beat, straight off the running origin:

```text
BNBUSDT BUY $20  conviction 0.85 (high)
  news  +0.75  (bullish @ 0.75)
  chart +0.56  (up regime, price +7.9% vs EMA200)
  no breakout: 1.8% below the 10-bar high
  volatility 0.97% ATR, RSI 70
  news and chart AGREE
```

Every number on the chart half of that came off Binance Agent OS.

---

## 6. Execution: spot and perpetuals

Two venues, two separate seams, **54 real fills between them**, and not one of them placed
by a human pressing a button.

### 6.1 Binance Spot, Demo Mode — `src/lib/exchange.ts`

Order execution, hand-rolled REST + HMAC signing. No SDK.

**Demo Mode specifically, and deliberately not Spot Testnet.** Both are free and fund-free,
but Demo Mode **mirrors the live exchange**: same features, same exchange filters, order
books tracking the real venue. Testnet runs an independent order book and wipes balances
monthly. When the strategy computes a position size that Binance's `NOTIONAL` filter would
reject in production, we want to discover that here, against production's own filters.

Verified: BTCUSDT agreed **within one cent** across mainnet, Demo Mode and Binance MCP — so
which read rail serves a beat does not move the numbers the strategy runs on.

Real fills on the deployed origin, from the unattended scheduler:

| Order id | Symbol | Side | Quantity | Filled at | Notional |
|---|---|---|---|---|---|
| `62348755959` | BTCUSDT | BUY | 0.00018 | 79,850.01 | $14.37 |
| `62350045713` | BTCUSDT | BUY | 0.00006 | 79,915.15 | $4.79 |
| `6979890074` | BNBUSDT | BUY | 0.026 | 768.45 | $19.98 |
| `7061181194` | BNBUSDT | BUY | 0.099 | 750.99 | $74.35 |
| … | | | | | **39 spot fills total** |

### 6.2 Binance USDⓈ-M Futures — `src/lib/futures.ts`, 710 lines

Its own seam rather than a boolean on the spot one, because **futures is not spot with a
leverage field bolted on** — and each of these four differences broke something the first
time it was assumed away:

| Difference | What it broke |
|---|---|
| Different host, different key pair | A key that signs Demo Mode returns `-2015` on the futures host. Silent until it isn't |
| **No `quoteOrderQty`** | Spot lets you say "spend $20". `/fapi/v1/order` demands `quantity` in **base units**, rounded to the symbol's `stepSize`, or it rejects outright. `quantityFor()` is that rounding, and it is not optional |
| **Positions are signed** | A short is a real position with a negative quantity, not the absence of a long. The entire P&L engine had to learn this |
| **Notional is not margin** | $20 at 5× posts $4 of margin and carries $20 of exposure. The budget layer checks **notional** on both venues, so one cap means one sentence, and leverage can never quietly multiply the daily limit |

**Why futures at all:** `trendSignal()` has returned `side: "short"` since the very first
commit, and every short breakout it found was computed and then thrown away, because a spot
account cannot act on one. **Half the analysis engine was dead code.** This rail made it
live, and 15 of the 54 fills are perps.

A genuine surprise worth passing on: **the futures testnet accepted the spot demo key
pair.** We had budgeted time for a second credential dance that turned out to be
unnecessary — and `futuresMode()` reports which pair is actually in use, so that
convenience never silently becomes an assumption.

Also fully mapped, because it silently determines what the agent can do at all: **futures
minimum notionals are per symbol**, and one of them sits above the default approval
threshold.

| Symbol | Futures floor | Fills unattended at current caps? |
|---|---|---|
| BNBUSDT | ~$7.65 | yes |
| ETHUSDT | $20.00 | yes, in the $20–$25 band |
| BTCUSDT | $50.00 | only above a $50 approval threshold |

`sizeCeiling` in [`src/lib/llm.ts`](src/lib/llm.ts) is `min(maxTradeUsd,
requireApprovalAboveUsd)`, so the Signal Agent is told the **true** ceiling and correctly
never proposes a BTC perp it could not fill. Three numbers, one source, no drift.

### 6.3 What is reachable, mapped exhaustively

`binance-cli` takes `BINANCE_API_ENV=prod|testnet|demo`, and the accepted set turns out to
be **decided per product** — a finding that is not in any documentation and that determines
what an unfunded developer can build at all:

```text
PRODUCT         demo     testnet  prod
spot              ok       ok       ok     <- every price and candle, and spot execution
futures-usds      ok       ok       ok     <- perpetuals
convert         REFUSED  REFUSED    ok
margin-trading  REFUSED  REFUSED   auth
wallet          REFUSED  REFUSED   auth
```

`REFUSED` is emitted **client-side, before any request leaves the machine**:

```text
Error: Invalid api env, valid values: prod
```

Because the refusal happens before the network, no credential and no
`BINANCE_<PRODUCT>_BASE_PATH` override reaches past it.

**Spot and futures accept demo and testnet — which is exactly why those are the two venues
Omon trades**, and it is the mechanism behind "$0 of real money" on the scoreboard. Not
restraint. An actual supported path, found by probing every product against every
environment and writing down the matrix.

```bash
npx tsx scripts/agent-os-matrix.ts --verbose   # regenerates every cell, including exit code
```

Published live at [`/api/agent-os`](https://www.omon-ai.duckdns.org/api/agent-os) under
`reachability`, so it is a fact other agents can read, not a claim that only exists in this
file.

### 6.4 Agent OS published as machine-readable fact

Every statement in this section is also readable at a URL, without cloning anything. That
is deliberate: **a README claim is a claim; a live endpoint is evidence.**

| Endpoint | What it publishes | Free? |
|---|---|---|
| [`/.well-known/x402`](https://www.omon-ai.duckdns.org/.well-known/x402) | The full catalogue, including an `agentOs` block naming every surface, its tools and its live status | yes |
| [`/api/agent-os`](https://www.omon-ai.duckdns.org/api/agent-os) | Per-seam mode, tools resolved, token health (never the token), the reachability matrix, and which rail served the last read | yes |
| [`/api/b402`](https://www.omon-ai.duckdns.org/api/b402) | The exact BSC challenge Omon issues, byte for byte | yes |
| [`/.well-known/oauth-client`](https://www.omon-ai.duckdns.org/.well-known/oauth-client) | Omon's OAuth client metadata document. This URL **is** its `client_id` | yes |
| [`/api/mcp`](https://www.omon-ai.duckdns.org/api/mcp) | Omon's own MCP server. Six tools | 4 of 6 |

Two details inside that manifest are worth pointing at directly.

**`poweredBy`, per endpoint.** A buying agent deciding whether to pay for a signal can
inspect the provenance of what it is buying *before* it spends anything:

```json
"poweredBy": [
  "binance-skillhub:spot klines",
  "binance-skillhub:spot ticker-price",
  "binance-mcp:spot_klines",
  "binance-mcp:spot_tickerPrice",
  "llm:gemini" ]
```

**`executionPolicy`**, which answers the question a judge would ask, before they ask it:

> "Reads try Binance MCP, then the Skill Hub CLI, then plain REST, and `/api/agent-os`
> reports which rail actually served the last call. Order writes go through Spot Demo Mode
> and the USDⓈ-M futures host only. The MCP token authorises a real Binance account, so no
> order is ever placed over MCP."

---

## 7. The beat, end to end

One beat, every five minutes, unattended, since deployment.
[`src/lib/tick.ts`](src/lib/tick.ts) is the whole thing — and the console's manual button
calls the **exact same function**, because a demo button that runs different code from the
scheduler proves nothing at all about the running system.

| # | Step | Where |
|---|---|---|
| 0 | **Check the book for an exit first.** A stop, a target or a time limit outranks any new idea, and a beat that is exiting skips the model entirely | [`src/lib/exits.ts`](src/lib/exits.ts) |
| 1 | Pull headlines from RSS feeds. No key, no signup, no vendor | [`src/lib/news.ts`](src/lib/news.ts) |
| 2 | **Intel Agent**: headline → `{assets, direction, confidence, thesis}`, structured output | [`src/lib/llm.ts`](src/lib/llm.ts) |
| 3 | Cache the intel — deduped, 5-minute TTL, durable across restarts | [`src/lib/intel-cache.ts`](src/lib/intel-cache.ts) |
| 4 | **Read Binance candles and prices through Agent OS**, stamping the rail | [`src/lib/exchange.ts`](src/lib/exchange.ts) |
| 5 | Compute the chart half: regime, breakout, ATR, RSI, conviction | [`src/lib/strategy.ts`](src/lib/strategy.ts) |
| 6 | **Signal Agent**: news + chart → a sized, venue-routed trade | [`src/lib/llm.ts`](src/lib/llm.ts) |
| 7 | Establish position facts *before* the verdict: what is held on spot, whether a futures order opens or closes | [`src/lib/tick.ts`](src/lib/tick.ts) |
| 8 | **Budget gate**: ALLOW, BLOCK or REQUIRE_APPROVAL — recorded either way | [`src/lib/budget.ts`](src/lib/budget.ts) |
| 9 | On ALLOW only, place the order, record the **fill with its price**, update P&L | [`src/lib/pnl.ts`](src/lib/pnl.ts) |

**The beat is single-flight, and that is load-bearing rather than tidy.** The scheduler
firing while someone presses the console button would run two beats concurrently,
double-spend the model quota, and race two orders against one budget check. Overlapping
callers get the in-flight beat's result instead.

**`reduceOnly` is decided in step 7 and never taken from the model.** Whether an order
closes a position is a *fact about the position*, not an opinion the Signal Agent gets to
have.

---

## 8. Knowing when to sell

For most of this project's life there was no step 0, and its absence was the single worst
thing about the strategy. A position opened and then sat there until the Signal Agent
happened, independently, to form an opposing view on that same symbol. That is not a
strategy with a hold period. **It is a strategy that forgets.**

[`src/lib/exits.ts`](src/lib/exits.ts). No model, no network, **26 assertions**.

| Rule | Default | Why |
|---|---|---|
| **Take-profit** | **+2.5%** | Momentum from a headline decays. Bank it |
| **Stop-loss** | **−1.5%** | Tighter on purpose. The thesis is news-driven momentum, so a position going the wrong way is evidence the read was **wrong**, while one going the right way is only evidence it was right *so far*. Losers should die faster than winners are cut |
| **Time-stop** | **6h** | A thesis derived from a six-hour-old headline is not a thesis. The news has been priced, and holding past it is a directional bet nobody took deliberately |

**The model is never asked.** Whether to *keep* a position is arithmetic on something that
already exists, and arithmetic is what a language model is worst at. More importantly, an
exit is the half of a trade that limits damage: it has to work on the beat where the model
is rate-limited, hallucinating, or simply down.

**Percentages are measured against notional on both venues, never return-on-margin.** At 3×
those differ threefold, so a target read off margin would fire on a 0.83% move on futures
while spot waited for the full 2.5%. One number, one meaning — the same discipline the
budget layer applies to `sizeUsd`.

### Three bugs this found on first contact with the real ledger

All three had been sitting there invisibly, because nothing had ever tried to sell.

1. **The agent could not close a position it had accumulated.** A $25 per-trade cap with a
   $1000 daily allowance had let a spot position reach **$198** over several beats, and the
   stop that wanted to close it was refused for exceeding the per-trade cap. The daily cap
   had always exempted closes; the per-trade cap and the approval threshold did not — so
   the "an agent must always be able to get out" rule was only two-thirds true. It is now
   the general rule. That $198 close subsequently filled as order `11684019827`.

2. **A position too small to close would have starved the agent permanently.** Closing a
   $14.79 perp rounds the quantity down to the symbol's step and left $7.40 behind — under
   BNBUSDT's $7.52 futures minimum, and therefore **unclearable by any order at all**.
   Because exits run *before* the model, that stranded position was proposed and refused on
   every single beat, pre-empting intel each time. The agent would never have opened
   another trade for the rest of its life. An exit the exchange would reject is now not an
   exit: the beat names the stranded position in the log and falls through.

3. **A stop-loss closed half a position and recorded it as closed.** This is the one that
   would have cost real money. The close was sized from `notionalUsd` — which is
   `|qty| × entry` — but the order path converts dollars back into units by dividing by the
   **current** mark and flooring to the symbol's step. Entry dollars buy fewer units once
   price has moved against you, which is *precisely* when a stop fires. A 0.02 BNB short
   entered at 739.57 and stopped at 752.71 asked for $14.79; that is 0.0196 at the mark,
   which floors to **0.01** on a 0.01 step. Half the short stayed open, still exposed, on
   the trade whose entire job was to remove the exposure. Coarse steps make it worse — a
   two-step position loses half rather than a crumb — and ETHUSDT escaped only because its
   step is fine enough that the floor happened to land on the position. Futures closes are
   now sized on the **live mark**, so the division is exact.

The third one is worth dwelling on, because it is the exact failure mode this whole section
exists to prevent, and it was *created* by the section itself. **An exit that half-fires is
worse than no exit at all**: no exit leaves you exposed and honest, while a half-fill leaves
you exposed and holding a ledger that says you are flat.

The console shows the live distance to all three exits on every open position, so the
policy is visible *before* it fires rather than only afterwards.

```bash
npx tsx scripts/exits-test.ts   # 26 assertions, fixtures, no clock and no network
```

---

## 9. The budget layer: thirteen checks, no model

[`src/lib/budget.ts`](src/lib/budget.ts). **No model. No network. Thirteen checks. 53
assertions.** Model output is treated as untrusted input, and `sizeUsd` is treated as
actively hostile.

This is the part of the project with no cleverness in it, and it is the part that makes the
rest safe to run unattended. **159 of the 241 trades this agent has proposed were refused
here** — a 66% refusal rate, every one of them recorded with the numbered check that
refused it.

Every trade runs the whole sequence, cheapest and most absolute first, so the reason
returned is the most *fundamental* thing wrong rather than whichever rule happened to run
last. **The gate returns the entire trace, not just the verdict**, and the console draws it
as thirteen squares under each order.

| # | Check | Default | Refuses when |
|---|---|---|---|
| 1 | size is a positive number | — | The model emitted `NaN`, `Infinity`, a negative, or a string that coerced badly |
| 2 | symbol is on the allowlist | BNB, BTC, ETH | Anything else. Ever |
| 3 | quote is fresh | 30s | The mark backing the size is older than this. A stale mark silently voids check 9 |
| 4 | venue is enabled | — | A futures order on a build with futures off |
| 5 | leverage within ceiling | 3× | Mirrored from the futures seam, so there is one number and not two that can disagree |
| 6 | spot sell is covered | — | Selling more than Omon's own fills say it holds. Spot cannot short; this would bounce `-2010` |
| 7 | symbol is tradable at this cap | — | The symbol's floor is above the per-trade cap, so it cannot trade here at *any* size |
| 8 | size meets the symbol minimum | — | Below the exchange's per-symbol notional floor |
| 9 | size within per-trade cap | $25 | A single trade larger than this |
| 10 | daily loss halt | $50 | The trailing 24h is that far down. **Opens only** |
| 11 | drawdown within limit | $75 | That far below the high-water mark. Does not reset with the day. **Opens only** |
| 12 | within daily spend cap | $100 | Rolling 24h, from the durable ledger. **Opens only** |
| 13 | within auto-approve threshold | $25 | Above this, a human decides. Usually the one that actually binds |

Checks 10 and 11 exist because 9, 12 and 13 all bound how much can be **committed**, and
none of them notices that every one of those trades *lost*. Check 10 catches one bad day;
check 11 catches three mediocre ones in a row, because it does not reset when the window
rolls.

Both are denominated in dollars rather than percentages. A percentage needs account equity
as its denominator, that is not derivable from a fill ledger, and inventing one from cost
basis would produce a number that looks precise and means nothing.

**Three rules that are safety properties rather than conveniences:**

1. **Closing is never blocked by a spending cap.** The cap counts trades that *increase*
   exposure and exempts every trade that reduces it. A cap that also throttles exits can
   leave an agent holding a position it is *forbidden to close*, which is a strictly more
   dangerous state than the one the cap was protecting against. **An agent must always be
   able to get out.**
2. **`sizeUsd` means notional on both venues.** $20 at 3× posts about $6.67 of margin and
   carries $20 of exposure. The cap checks the $20, so "$100 a day" means one thing on both
   venues and leverage cannot quietly multiply it. Margin is reported alongside, never
   instead.
3. **A check that cannot measure its input skips rather than assuming healthy.** An
   unmeasured quote age is not "fresh", and an unmeasured drawdown is not "zero". The trace
   marks those grey, distinct from a pass, so the console never shows the gate doing more
   work than it actually did. Four of the 53 assertions cover this case alone.

**A refusal that leaves no trace is indistinguishable from having no budget layer at all**,
so BLOCK is written to the durable ledger with the same weight as a fill, and the console
renders refusals in the same feed as orders. Force one live, right now:

```bash
curl -X POST "https://www.omon-ai.duckdns.org/api/cron/tick?sizeUsd=500"
# BLOCK, with the numbered check that refused it, in the response and in the ledger
```

The full trace is also available to other agents over MCP, unpaid, as `omon_gate`.

---

## 10. Getting paid: x402 **and** B402

**Both payment rails are implemented.** Not one rail with a second one mentioned in a
roadmap — two complete implementations behind a single seam, selectable with one
environment variable, each producing a real, correctly-shaped payment challenge.

Both agents' output is sold behind a genuine HTTP `402 Payment Required`. An outside agent
holding nothing but the URL can discover the service, read the price, pay in USDC, and
receive the data. **No account. No API key. No signup form. No human.**

```bash
node scripts/pay.mjs /api/intel     # an outside client pays a real 402, end to end
```

### 10.1 x402 — live, and settled 14 times

| | |
|---|---|
| Rail | x402, Base Sepolia, public facilitator |
| Status | **Settling.** 14 on-chain payments received |
| Sold over | HTTP (`/api/intel`, `/api/signals`) **and** MCP (`omon_intel`, `omon_signal`) |
| Discovery | [`/.well-known/x402`](https://www.omon-ai.duckdns.org/.well-known/x402), no directory needed |

Real settled transactions, from [`data/purchases.jsonl`](data/):

| Transaction | Endpoint | Chain |
|---|---|---|
| `0xd887ac57917daf8aa2de7fd4e3a6742d171138aa76241715cf224da8a74aacbb` | `/api/intel` | Base Sepolia |
| `0x37256ac5d4f504a5fef01e576c179b2b292e3f02108828fbe3e6244c285a59b8` | `/api/signals` | Base Sepolia |
| `0x8cd75eea07a4d93b598e6ce60d714293696d23d73b511dc73da4d5517e6c26a7` | `/api/intel` | Base Sepolia |
| `0xb580ba7dbc0b7c97ebd15f18c05095ec2af0f293dccea041d16341f87776aeaa` | `/api/signals` | Base Sepolia |
| … | | **14 settled in total** |

**An unpaid request is not a wall.** It returns the challenge *plus a redacted preview*
built by [`src/lib/service.ts`](src/lib/service.ts) — the same function that feeds the
manifest — so a buying agent can evaluate the product before spending, and the preview and
the catalogue can never drift apart, because they are one function.

### 10.2 B402 — Binance's own rail, mapped against the vendor SDK

[`src/lib/b402.ts`](src/lib/b402.ts) maps Omon's payment challenge onto **Binance
OnchainPay**, using `@bnb-chain/b402` — the provider's own package, not a reimplementation
of it.

| | |
|---|---|
| Provider | `@bnb-chain/b402` v0.2.1 |
| Network | `eip155:56` — BNB Smart Chain |
| Scheme | `exact` |
| Transfer method | `eip3009` |
| Pricing | **Atomic units**, converted by `toAtomicUnits()` with per-token decimals |
| Published live | [`/api/b402`](https://www.omon-ai.duckdns.org/api/b402) — the exact challenge, byte for byte |
| Tested | **25 offline assertions, against the provider's own parser** |

Three rails, one seam, one environment variable:

```text
X402_RAIL=testnet        public facilitator, Base Sepolia.       Default.
X402_RAIL=b402-preview   B402 challenge published + inspectable. No credentials needed.
X402_RAIL=b402           B402 on BNB Smart Chain.
```

Routes never import a scheme or a facilitator directly — they import
[`src/lib/x402.ts`](src/lib/x402.ts) and nothing else. **Swapping the money rail is one
variable, not a refactor.**

**The B402 mapping found a real bug in how the route was configured, and that bug is now a
regression test against the vendor's own code.** `paidRoute()` was handing B402 the same
`price: "$0.01"` string the public rail accepts — and `B402ExactServerScheme.parsePrice`
rejects a monetary price outright without a `moneyParser`. `enhancePaymentRequirements`
then demands `extra.assetTransferMethod`, `extra.name` and `extra.version`, none of which
were being sent.

The rail would have **booted perfectly clean and failed on the first paid request** — the
worst possible shape for that class of bug, because credentials would have been blamed for
what was actually a route-config gap.

[`scripts/b402-test.ts`](scripts/b402-test.ts) now asserts that `parsePrice` **rejects** the
old form and **accepts** what `b402Accepts()` builds. 25 assertions, fully offline, no
credentials, running against the provider's real implementation:

```bash
npx tsx scripts/b402-test.ts     # 25 passed
```

**Preview mode keeps exactly one challenge payable, and that is a deliberate correctness
property.** The tempting way to feature a second rail is to advertise a BSC challenge and
quietly settle somewhere else — which hands a buyer a payment requirement it cannot pay, on
a chain nothing is watching. Instead, preview publishes the B402 challenge **alongside** the
one that settles, labelled `b402Preview`, and built by **the same `b402Accepts()` the live
rail calls**. What you see in preview is byte for byte what a buyer gets on BSC.

`settlementRail` is a separate export from `rail` for the same reason: nothing that reports
where money actually landed can ever show "b402" over a figure that settled elsewhere.

```bash
curl -s https://www.omon-ai.duckdns.org/api/b402 | jq '.b402.wouldAdvertise'
# the exact accepts entry, on eip155:56, eip3009, atomic units — built by the live code path
```

### 10.3 Why two rails

The open rail proves the model works with no permission from anyone. The Binance rail is
where an agent economy built on Agent OS would actually settle. **Building only the first is
a protocol demo; building only the second is a vendor integration. Building both, behind one
seam, with one variable between them, is the thing that survives either future.**

---

## 11. Engineering highlights: the five bugs worth your time

Not a feature list. These are the five findings that **changed the architecture**, and four
of them were money bugs that a demo would never have surfaced because a demo never runs long
enough.

### 1. The scheduler was enforcing the daily cap twice, independently

`src/instrumentation.ts` is bundled into a **separate module graph** from the route
handlers, so anything it imports from `@/lib` is a *different instance* — its own ledger,
its own caches, its own budget arithmetic. The first heartbeat called `runTick()` directly.

Observed live: a scheduled beat **filled a real order** while every route still reported
`actionCount: 0`, and the scheduler's `spentTodayUsd()` read its own empty ledger. **Real
exposure was twice the configured limit**, and nothing on screen showed it.

The fix is a rule, not a patch: instrumentation holds a timer and a `fetch`, and nothing
else. It calls its own `POST /api/cron/tick` over loopback, so all state stays in one graph
and the heartbeat behaves identically to an external cron would.

### 2. One signal was traded once per beat, not once

The signal cache serves the same newest row for its whole TTL, so consecutive beats inside
that window each placed another order off it. Observed: two beats a minute apart both filled
BUY BTCUSDT off a single signal. **A quiet news hour would have re-bought one stale idea
until the daily cap was gone.**

`ledger.hasTradedSignal()` now gates it, derived from the action rows rather than a second
counter — so only orders that actually reached the exchange count, and the guard cannot
drift from reality.

### 3. The Signal Agent was told to propose sizes the gate would always refuse

The prompt said "between 5 and 50" as a hard-coded literal while `BUDGET_MAX_TRADE_USD` was
25 — and the very next line told the model to size **up** on agreement. So the **strongest**
signals were precisely the ones guaranteed to be refused, while the intel feed looked
perfectly healthy. A full day could run with zero fills and nothing obviously wrong on
screen.

The ceiling is now derived from `limitsFromEnv()`, so the two numbers cannot drift apart
again. One source, three consumers.

### 4. Restarting the process was a way to refill the budget

Every piece of state was in memory. `pm2 restart` reset the ledger, the P&L, both caches and
the beat counter — which meant a restart handed the agent **a fresh daily allowance**, let
it re-trade an idea it had already bought, and re-paid the model for headlines it had
already analysed.

[`src/lib/store.ts`](src/lib/store.ts) is the fix: append-only JSONL for the ledger and
fills, whole-document JSON written to a temp file and atomically renamed for the caches.

**Appends are synchronous on purpose.** The failure being defended against is the process
dying between "Binance filled the order" and "the row reached the disk", and a lost fill
leaves an open position with no cost basis — a position the agent does not know it holds.

Verified by **`SIGKILL`, not a graceful restart**, with
[`scripts/store-test.ts`](scripts/store-test.ts) spawning real second processes. That
detail matters: an earlier version of that test faked a restart by clearing the module
cache, and **would have passed with persistence removed entirely**.

### 5. There was no P&L, and there could not have been

`recordAction()` stored what the budget layer *decided*, and the order came back with
`executedQty` and `cummulativeQuoteQty` which were used for one console line and then
dropped on the floor. No price meant no position, which meant no profit.

[`src/lib/pnl.ts`](src/lib/pnl.ts) now derives positions and profit from fills, with three
decisions worth not re-litigating:

- **Average cost rather than FIFO**, so a viewer can check the arithmetic by hand.
- **Selling what this ledger never bought earns nothing.** Pre-funded BNB has no cost basis
  here, so it goes into `unbasedSells` with an amber note rather than fabricating profit out
  of a balance the agent did not create.
- **An open position with no mark is excluded and named**, because a missing price must read
  as *missing* and never as a zero that looks like a loss.

**P&L is never netted against x402 revenue.** Different rails — USDC on Base Sepolia in,
demo USDT out — and one combined figure would imply a settlement between them that does not
exist. Two cards, side by side, each labelled with its own rail.

---

## 12. Quick start

Nothing here requires funding. Market reads need no credentials, Demo Mode is free, and
every seam falls back to recorded fixtures and **says so on screen** rather than pretending.

```bash
git clone https://github.com/MikeMoulder/Omon-AI && cd Omon-AI
npm install
cp .env.example .env.local      # fill in what you have. every seam has a fallback
npm run dev                     # http://localhost:3000
```

Then, in another shell:

```bash
curl -X POST 'localhost:3000/api/intel/refresh?force=1'   # fill the cache
curl localhost:3000/api/agent-os | jq .                   # which rails are live for you
curl -X POST localhost:3000/api/cron/tick                 # run one beat by hand
```

**To light up the live Binance Agent OS read rail** (optional, free, no credentials):

```bash
# install binance-cli from github.com/binance/binance-cli, then:
npx tsx scripts/skillhub-smoke.ts --verbose     # prices + candles, via: cli
```

**To talk to Omon as an MCP server**, from any MCP client:

```json
{ "mcpServers": { "omon": { "type": "http",
    "url": "https://www.omon-ai.duckdns.org/api/mcp" } } }
```

**The keys, and what each is for.** All 38 are documented in
[`.env.example`](.env.example) with empty values. The four that change behaviour most:

| Key | Needed for | Without it |
|---|---|---|
| `GEMINI_API_KEY` | Both agents | Fixture intel and signals, labelled as fixtures |
| `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` | Order execution on Demo Mode | Prices still work; orders become fixture orders |
| `BINANCE_MCP_ACCESS_TOKEN` | The MCP read rail | Falls through to Skill Hub, then REST, and reports which |
| `X402_RAIL` | Which payment rail | Defaults to the public facilitator on Base Sepolia |

---

## 13. Verify every claim on this page

Every command here runs without credentials unless marked otherwise.

| Claim | Command | Expected |
|---|---|---|
| The budget gate is real | `npx tsx scripts/budget-test.ts` | **53 passed**, 13 checks |
| The P&L math is right | `npx tsx scripts/pnl-test.ts` | **29 passed** |
| The exit rules are right | `npx tsx scripts/exits-test.ts` | **26 passed** |
| The B402 mapping is right | `npx tsx scripts/b402-test.ts` | **25 passed**, against the vendor's own parser |
| Futures sizing is right | `npx tsx scripts/futures-test.ts` | **9 passed** |
| State survives a SIGKILL | `npx tsx scripts/store-test.ts` | **12 passed**, spawns real processes |
| The indicator port is exact | `npx tsx scripts/indicators-test.ts <path>` | Matches the reference over 19,980 bars |
| Agent OS is actually serving | `npx tsx scripts/skillhub-smoke.ts --verbose` | `via: "cli"` |
| MCP is not silently faked | `npx tsx scripts/mcp-smoke.ts --verbose` | Fails on a REST fallback, by design |
| **Omon answers AS an MCP server** | `npx tsx scripts/mcp-server-smoke.ts --base https://www.omon-ai.duckdns.org` | **32 checks** |
| A stranger's agent can discover and pay | `npx tsx scripts/discovery-smoke.ts` | **22 checks** |
| The console shows what the system did | `npx tsx scripts/console-smoke.ts --tick` | **23 checks**, drives a live beat |
| An outside client can pay a 402 | `node scripts/pay.mjs /api/intel` | A settled transaction |
| Which Binance products are reachable | `npx tsx scripts/agent-os-matrix.ts --verbose` | The full matrix, regenerated |

**154 offline assertions and 77 live checks, all green, run immediately before this README
was written.**
