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
