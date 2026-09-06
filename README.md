# Omon

**An autonomous trading agent that runs on Binance Agent OS, and sells what it learns to other agents over a real HTTP 402.**

[Live console](https://www.omon-ai.duckdns.org) · [Machine-readable manifest](https://www.omon-ai.duckdns.org/.well-known/x402) · [Agent OS status, live](https://www.omon-ai.duckdns.org/api/agent-os)

Built for the **Binance Agent OS Mini Hackathon**, Track A. Every market read in this
product comes off a Binance Agent OS surface, and the product says which one, live, on
every request.

```json
GET https://www.omon-ai.duckdns.org/api/agent-os

{ "agentOs": {
    "mcp":      { "mode": "off",  "reason": "no MCP token, client refused: 3346001" },
    "skillHub": { "mode": "live", "version": "binance-cli 2.1.1" },
    "exchange": { "mode": "live", "reason": "binance spot @ demo-api.binance.com" } },
  "usage": { "prices": { "via": "cli", "tool": "spot ticker-price" } } }
```

That last line is the whole thesis of this README. Omon does not claim an integration.
It reports, on every single read, which Binance rail actually served it, and it fails
its own smoke tests if the answer is "none of them".

---

## Contents

| # | Section | What is in it |
|---|---|---|
| 1 | [What is real, and what is not](#1-what-is-real-and-what-is-not) | The honesty table. Read this before anything else |
| 2 | [The problem](#2-the-problem) | One person, one pain |
| 3 | [What we built](#3-what-we-built) | The product in one screen |
| 4 | [How we used Binance Agent OS](#4-how-we-used-binance-agent-os) | **The main event.** Six surfaces, one seam, zero fabrication |
| 5 | [How it works, end to end](#5-how-it-works-end-to-end) | The beat, in nine numbered steps |
| 6 | [The budget layer](#6-the-budget-layer-the-part-with-no-model-in-it) | The part with no model in it |
| 7 | [Getting paid: x402 and B402](#7-getting-paid-x402-and-b402) | The 402, and the Binance rail behind it |
| 8 | [Technical highlights](#8-technical-highlights-the-five-bugs-worth-your-time) | The five bugs worth your time |
| 9 | [Quick start](#9-quick-start) | Commands that work on a stranger's machine |
| 10 | [Verify every claim on this page](#10-verify-every-claim-on-this-page) | One command per claim |
| 11 | [Repo map](#11-repo-map) | Where everything lives |
| 12 | [Limitations, and what is next](#12-limitations-and-what-is-next) | Built, Next, Vision, kept apart |

---

## 1. What is real, and what is not

Stated first, because both money rails here are non-production and a judge would see
that in ten seconds anyway.

| Layer | Where it runs | Real? |
|---|---|---|
| Market data: prices, OHLCV candles | **Binance Skill Hub** (`binance-cli 2.1.1`) | **Live**, real Binance market data, no credentials |
| Market data: the MCP path | **Binance MCP** (`agent.binance.com/mcp/agentic`) | **Built and complete, refused at the door.** Binance allowlists MCP clients; ours is not on the list. Error `3346001`. See [4.3](#43-surface-one-binance-mcp-server) |
| Order execution, spot | **Binance Spot Demo Mode** (`demo-api.binance.com`) | **Live.** Real matching engine, real order ids, demo funds |
| Order execution, perpetuals | **Binance USDⓈ-M Futures testnet** | **Live.** Real engine, leverage capped at 3x, demo funds |
| Agent-to-agent payments | x402, Base Sepolia | Real protocol, real settlement, test USDC |
| Binance Pay / B402 | `@bnb-chain/b402` | **Mapped, published, inspectable, not settling.** Merchant onboarding needs a business entity |
| The agent loop itself | Unattended, every 5 minutes, on a public VPS | **Live right now.** 41 beats, 4 filled orders as of this writing |

**Total real money spent or moved by this project: $0.** That is a design decision, not
a compromise. Every rail chosen here is one an individual developer can reach without a
business entity, without a funded account, and without asking anyone for permission.

**Not built:** multi-user accounts, a mainnet path, and B402 live settlement. Each is
blocked on a credential we cannot obtain, and each is named in the section that would
have used it.

---

## 2. The problem

An agent that trades needs three things: market data it can trust, a venue that will
execute, and money. The first two now have an official answer at Binance. The third
does not: an autonomous agent has no way to earn, so every agent at every hackathon is
a **cost centre with a private key**, spending down a balance a human topped up.

Omon is built the other way round. It reads Binance markets through Agent OS, forms a
view, trades it on a real matching engine, and then **sells the view it just formed** to
any other agent on the internet for one cent, over an open standard, with no account, no
API key, and no signup form.

---

## 3. What we built

One process. Two model-driven agents. One layer of plain code between them and money.

```
                     ┌──────────────────────────────────────────────┐
   RSS headlines ───►│  Intel Agent    (Gemini, structured output)   │
                     │  headline -> {assets, direction, confidence}  │
                     └───────────────────┬──────────────────────────┘
                                         │
   BINANCE AGENT OS                      ▼
   ┌────────────────────┐    ┌───────────────────────────────────────┐
   │ 1. MCP  spot_klines│───►│  Signal Agent  (Gemini + technicals)  │
   │ 2. Skill Hub CLI   │    │  news + chart -> conviction -> signal │
   │ 3. REST (the floor)│    └───────────────────┬───────────────────┘
   └────────────────────┘                        │
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │  BUDGET LAYER  (plain code. no model,│
                              │  no network, 28 tests)               │
                              │  ALLOW / BLOCK / REQUIRE_APPROVAL    │
                              └───────────────────┬──────────────────┘
                                                  │ ALLOW only
                     ┌────────────────────────────┴───────────────┐
                     ▼                                            ▼
        Binance Spot Demo Mode                    Binance USDⓈ-M Futures testnet
        (real engine, demo funds)                 (perps, reduceOnly on closes)
                     │                                            │
                     └──────────────► fills ledger ◄──────────────┘
                                           │
                                           ▼
                              P&L, positions, and the console
                                           │
     Both agents' output is sold ──────────┘
     behind a real HTTP 402, discoverable at /.well-known/x402
```

Everything above is running unattended on a public origin as you read this. The console
shows a countdown to the next beat so nobody has to take that on faith.

---

## 4. How we used Binance Agent OS

This is the section the hackathon is about, so it is the longest one, and every claim in
it ends at a file path or a URL you can open right now.

The short version: **Agent OS is not a logo on this project, it is the data path.** Six
Binance surfaces are wired in. Two of them carry every market read the trading strategy
runs on. One of them was fully implemented and then refused by a control on Binance's
side, and rather than delete the code or quietly claim it works, we shipped the client,
shipped the diagnosis, and made the product report its own disconnection out loud on
every request.

### 4.1 Every Agent OS surface, and what it carries

| # | Agent OS surface | What Omon uses it for | Where in the code | Status today |
|---|---|---|---|---|
| 1 | **Binance MCP Server** `agent.binance.com/mcp/agentic` | `spot_tickerPrice`, `spot_klines`, `spot_getAccount`. Reads only, never writes | [`src/lib/mcp.ts`](src/lib/mcp.ts) | Client complete. **Refused: `3346001`** |
| 2 | **Binance Skill Hub** `binance-cli` | `spot ticker-price`, `spot klines`. The candles the whole strategy runs on | [`src/lib/skillhub.ts`](src/lib/skillhub.ts) | **Live and serving** |
| 3 | **Binance Exchange API**, Spot Demo Mode | Order execution, balances, exchange filters | [`src/lib/exchange.ts`](src/lib/exchange.ts) | **Live**, 4 orders filled |
| 4 | **Binance USDⓈ-M Futures** testnet | Perpetuals, leverage, `reduceOnly` closes | [`src/lib/futures.ts`](src/lib/futures.ts) | **Live**, order `2635918071` filled |
| 5 | **Binance Pay / OnchainPay (B402)** `@bnb-chain/b402` | The BSC payment rail, mapped and published | [`src/lib/b402.ts`](src/lib/b402.ts) | **Mapped, preview, not settling** |
| 6 | **Agent OS discovery conventions** | Publishing which of the above served each read | [`src/lib/service.ts`](src/lib/service.ts) | **Live** |

Six surfaces. Two of them exist in this project only because we went looking for a
second and a third path when the first one closed, and finding those paths is most of
the engineering story below.

### 4.2 The three-rail read stack

This is the design decision the rest of the project hangs off. Market reads are not
wired to one vendor call. They are a **stack of three rails, tried in order, with every
fall-through recorded and published**.

```ts
// src/lib/exchange.ts, getPrices() and getCandles(), simplified
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

| Rail | Surface | Credentials | Role |
|---|---|---|---|
| 1 | Binance MCP Server | OAuth 2.1, allowlisted client | Preferred. Takes over the moment a token exists |
| 2 | Binance Skill Hub CLI | **None** for market data | What actually serves today |
| 3 | Plain REST + HMAC | Demo Mode keys | The floor. Keeps the heartbeat alive when both are down |

**`noteMcpUse()` is the load-bearing part, not the fallback.** A silent fallback is an
integration that has quietly stopped existing, and it is the single most common way a
hackathon "integration" turns out to be a dead import. So every read stamps `via: "mcp"
| "cli" | "rest"` plus a reason, `GET /api/agent-os` publishes that stamp, the console
draws it as a status pill with the mode written on it in words, and two smoke scripts
**fail on purpose** if the data arrived over REST:

```bash
npx tsx scripts/mcp-smoke.ts --verbose        # fails if MCP silently fell back
npx tsx scripts/skillhub-smoke.ts --verbose   # PASS: prices + candles, via: cli
```

### 4.3 Surface one: Binance MCP Server

**What we built.** A complete, hand-rolled MCP client. No SDK, because one dependency
fewer is one dependency fewer, and the wire format is small enough to read:

| Piece | Detail |
|---|---|
| Transport | Streamable HTTP: JSON-RPC over POST, server free to answer `application/json` or SSE. Both parsed |
| Protocol version | `2025-06-18` |
| Handshake | `initialize`, then `tools/list`, then `tools/call` |
| Tool resolution | Name candidates tried in order (`spot_klines`, then `spot.klines`), because the naming differs by exposure. [`resolveTool()`](src/lib/mcp.ts) |
| Auth | OAuth 2.1, authorization code plus PKCE, with a loopback redirect. [`scripts/mcp-auth.ts`](scripts/mcp-auth.ts) |
| Client identity | **`client_id_metadata_document`.** There is no Binance developer portal, so Omon publishes its own client metadata at [`/.well-known/oauth-client`](https://www.omon-ai.duckdns.org/.well-known/oauth-client) and that URL **is** its `client_id` |
| Token storage | `.mcp-token.json`, gitignored, mode 600, renewable in place by the long-lived process |
| Write path | **There is none, deliberately.** See below |

**The read/write split is a safety property, not a preference.** The MCP token
authorises the operator's *real* Binance account with `canTrade: true`. An order placed
over MCP would spend real money. So `src/lib/mcp.ts` has no write path at all and its
file header forbids adding one, while orders go to a completely different host with
completely different keys and no real funds. Agent OS gave us a rail powerful enough
that the correct engineering response was to refuse to use half of it.

**Then Binance said no, and we wrote that down instead of hiding it.**
`scripts/mcp-auth.ts` works end to end. Binance fetches our client metadata document,
renders the "Agentic Account Access" consent screen with the operator's account and an
agentic-account picker, and then overlays:

```text
The AI Agent you are using is not currently supported.
Please connect using a supported Agent to continue. (3346001-2c9886bb)
```

Everything on our side is correct: PKCE, the redirect, the metadata document, the base
URL. What is refused is the **client identity**. `/.well-known/oauth-authorization-server`
still advertises `client_id_metadata_document_supported: true` and `/register` still
404s, so CIMD being *supported* does not mean any CIMD URL is *accepted*. Binance
allowlists which agent clients may connect and enforces it at the authorize step. For
comparison, the client Claude Code uses is
`https://claude.ai/oauth/claude-code-client-metadata`: same mechanism, allowlisted URL.

**Three things we did not do, and each one was tempting:**

1. We did not lift an allowlisted client's token into `.mcp-token.json`. That would
   present a credential minted for another client as our own, which is precisely the
   control Binance is enforcing, at a hackathon Binance is judging.
2. We did not delete `src/lib/mcp.ts` to make the repo look cleaner. It is a complete,
   correct client and the day the allowlist opens it takes over the read stack with no
   other change.
3. We did not write "powered by Binance MCP" in the README and hope. The manifest says
   `"status": "not connected"` with the reason attached, on every request, forever, until
   it is not true any more.

**This finding is a deliverable.** Any team building on Agent OS outside an allowlisted
IDE will hit exactly this wall, and `3346001` returns nothing useful in a search engine.
It is documented here with the probe that produced it.

### 4.4 Surface two: Binance Skill Hub, the rail that actually serves

When the MCP door closed, the honest options were to ship a Binance project with no live
Binance integration, or to find the other door. **Binance Agent OS has two read surfaces
and we had only probed one.**

[`binance-cli`](https://github.com/binance/binance-cli), the Skill Hub CLI, is official
Binance, needs **no credentials at all** for market data, and is not behind the
allowlist. Installed on the box as `binance-cli 2.1.1`, from the official release
tarball, **sha256 verified against the published checksum** rather than piping an
installer script into a root shell.

```bash
binance-cli spot ticker-price --symbol BNBUSDT
# {"symbol":"BNBUSDT","price":"773.76000000"}

binance-cli spot klines --symbol BTCUSDT --interval 1h --limit 200
# the identical array-of-arrays shape /api/v3/klines returns
```

That last property is why this took hours and not days: **the Skill Hub returns the same
candle shape as the REST endpoint**, so `decodeKlines()` parsed it unchanged and the new
rail was a swap inside an existing seam rather than a rewrite. The seam design from day
one paid for itself the day the primary rail died.

**Three engineering details in [`src/lib/skillhub.ts`](src/lib/skillhub.ts) worth naming:**

| Detail | Why it exists |
|---|---|
| `spawn` with `stdio: ["ignore","pipe","pipe"]` | `exec` and `execFile` leave the child's stdin an open unwritten pipe, and `binance-cli` **blocks reading it**. The process hangs forever with no output. This trap costs everyone who hits it about an hour |
| Binary resolution cached, with a 30s miss TTL | `cliMode()` is read on every price call. Stat-ing `PATH` every time would be waste, but caching the *miss* permanently would mean a CLI installed while the process runs needs a restart. The TTL is the compromise |
| **Batched reads: 3.3x measured** | `--symbols` fails in every documented form. `--json '{"symbols":[...]}'` works. On this rail the cost is process spawn, not network, so batching is real time: **three symbols, 1.96s looped versus 0.60s batched** |

**The `symbols` trap, fully mapped**, because the error message lies about the cause.
Binance's server-side regex is a Java character-class intersection reading "word
characters EXCEPT lowercase":

```text
["BTCUSDT","BNBUSDT"]      OK
["BTCUSDT", "BNBUSDT"]     -1100  Illegal characters   <- one space after the comma
["btcusdt","bnbusdt"]      -1100  Illegal characters   <- lowercase. IDENTICAL error
```

Two completely different causes, one indistinguishable error. `cliPrices()` upper-cases
defensively for exactly that reason, and the same trap behaves differently on each of
the three rails, mapped per rail in the code comments. On the MCP rail batching is
**impossible**, because the MCP layer serialises the array itself and inserts the fatal
space, so that rail must loop one symbol per call.

**The claim this makes true:** the OHLCV candles that
[`src/lib/indicators.ts`](src/lib/indicators.ts) and
[`src/lib/strategy.ts`](src/lib/strategy.ts) compute EMA, ATR, RSI and breakout
structure on are fetched through Binance Agent OS for real, with no token and no
allowlist, on the deployed origin, right now.

### 4.5 Surface three: Binance Exchange API, Spot Demo Mode

Order execution, hand-rolled REST plus HMAC in [`src/lib/exchange.ts`](src/lib/exchange.ts).

**Demo Mode, specifically, and not Spot Testnet.** Both are free and fund-free, but Demo
Mode mirrors the live exchange: same features, same exchange filters, order books
tracking the live venue. Testnet runs an independent order book and resets balances
monthly. When the strategy computes a position size that Binance's `NOTIONAL` filter
would reject, we want to find that out here.

Verified 2026-09-05: BTCUSDT agreed **within a cent** across mainnet, Demo Mode and
Binance MCP, so the read fallback does not move the numbers the strategy runs on.

Real fills on the deployed origin, from the unattended scheduler:

| Order id | Symbol | Side | Quantity | Filled at | Notional |
|---|---|---|---|---|---|
| `62348755959` | BTCUSDT | BUY | 0.00018 | 79,850.01 | $14.37 |
| `62350045713` | BTCUSDT | BUY | 0.00006 | 79,915.15 | $4.79 |
| `6979890074` | BNBUSDT | BUY | 0.026 | 768.45 | $19.98 |
| `6980105667` | BNBUSDT | BUY | 0.026 | 767.78 | $19.96 |

Nobody pressed a button for any of those.

### 4.6 Surface four: Binance USDⓈ-M Futures

[`src/lib/futures.ts`](src/lib/futures.ts) is its own seam rather than a flag on the spot
one, because **futures is not spot with a leverage field bolted on**, and each of the
four differences broke something the first time it was assumed away:

| Difference | What it broke |
|---|---|
| Different host, different key pair | A key that signs Demo Mode returns `-2015` on the futures host |
| **No `quoteOrderQty`** | Spot lets you say "spend $20". `/fapi/v1/order` demands `quantity` in base units, rounded to the symbol's `stepSize`, or it rejects outright. `quantityFor()` is that rounding, and it is not optional |
| Positions are **signed** | A short is a real position with negative quantity, not the absence of a long. The P&L math had to learn this |
| **Notional is not margin** | $20 at 5x posts $4 and carries $20 of exposure. The budget layer checks **notional** on both venues so one cap means one sentence, and leverage cannot quietly multiply the daily limit |

**Why futures at all:** `trendSignal()` has returned `side: "short"` since the first
commit, and every short breakout it found was computed and thrown away, because a spot
account cannot act on one. Half the analysis engine was dead code. This rail made it
live.

A genuine surprise worth passing on: **the futures testnet accepted the spot demo key
pair.** We had budgeted time for a second credential dance that turned out to be
unnecessary, and `futuresMode()` reports which pair is in use so that convenience never
becomes an assumption.

Also mapped, because it silently determines what the agent can actually do: **futures
minimum notionals are per symbol**, and one of them sits above our approval threshold.

| Symbol | Futures floor | Fills unattended at current caps? |
|---|---|---|
| BNBUSDT | ~$7.65 | yes |
| ETHUSDT | $20.00 | yes, in the $20 to $25 band only |
| BTCUSDT | $50.00 | **no**, it needs an approval threshold of $50 or more |

`sizeCeiling` in [`src/lib/llm.ts`](src/lib/llm.ts) is `min(maxTradeUsd,
requireApprovalAboveUsd)`, so the Signal Agent is told the true ceiling and correctly
never proposes a BTC perp it cannot fill. Three numbers, one source.

### 4.7 Surface five: Binance Pay and B402

Covered in full in [section 7](#7-getting-paid-x402-and-b402). The summary for this
section: the Binance OnchainPay rail is **mapped against the vendor SDK, published, and
inspectable at a free public endpoint**, and it does not settle, and the product says so
in the same breath.

### 4.8 Agent OS as a published fact, not a README claim

Every statement in this section is also machine-readable, at a URL, without cloning the
repo. That is deliberate: **a README claim is a claim, a live endpoint is evidence.**

| Endpoint | What it publishes | Free? |
|---|---|---|
| [`/.well-known/x402`](https://www.omon-ai.duckdns.org/.well-known/x402) | The full catalogue, including an `agentOs` block naming every surface, its tools, and its **live status** | yes |
| [`/api/agent-os`](https://www.omon-ai.duckdns.org/api/agent-os) | Per-seam mode, tools resolved, token health (never the token), and which rail served the last read | yes |
| [`/api/b402`](https://www.omon-ai.duckdns.org/api/b402) | The exact BSC challenge Omon would issue, which variables are unset, whether it is settling | yes |
| [`/.well-known/oauth-client`](https://www.omon-ai.duckdns.org/.well-known/oauth-client) | Our OAuth client metadata document. This URL **is** our `client_id` | yes |

Two details inside that manifest are worth pointing at directly:

**`poweredBy`, per endpoint.** A buying agent deciding whether to pay for a signal can
see the provenance of what it is buying before it spends anything:

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
> reports which rail actually served the last call. Order writes go through Spot Demo
> Mode REST only. The MCP token authorises a real Binance account, so no order is ever
> placed over MCP."

### 4.9 What the Agent OS data actually does

Agent OS is not decorating a price label on a screen here. The `spot_klines` payload is
the input to a real technical engine:

| Layer | File | What it computes |
|---|---|---|
| Indicators | [`src/lib/indicators.ts`](src/lib/indicators.ts) | EMA, ATR, RSI, prior range. Pure math, no network |
| Strategy | [`src/lib/strategy.ts`](src/lib/strategy.ts) | Trend regime, breakout structure, and a **conviction score** for how far the news and the chart agree |
| Signal | [`src/lib/llm.ts`](src/lib/llm.ts) | The Signal Agent, given both, sizes the trade inside the true ceiling |

The indicator port is **cross-checked against the original implementation bar for bar
over 19,980 bars** by [`scripts/indicators-test.ts`](scripts/indicators-test.ts). A
conviction line from a live beat, straight off the running origin:

```text
BNBUSDT BUY $20  conviction 0.85 (high)
  news  +0.75  (bullish @ 0.75)
  chart +0.56  (up regime, price +7.9% vs EMA200)
  no breakout: 1.8% below the 10-bar high
  volatility 0.97% ATR, RSI 70
  news and chart AGREE
```

Every number on the chart half of that came off Binance Agent OS.

### 4.10 Five things we learned about Agent OS that are not in the docs

Offered as the most useful thing this project can hand back to the people who built the
platform:

1. **MCP clients are allowlisted, and CIMD support does not imply CIMD acceptance.** A
   self-published `client_id` reaches the consent screen and is refused at the authorize
   step with `3346001`. `/register` 404s, so there is no self-service path.
2. **The Skill Hub CLI is a first-class second read surface**, and it is the one an
   unaffiliated developer can actually use. Zero credentials for market data.
3. **Batching behaves differently on every rail.** REST needs a hand-built string, MCP
   cannot batch at all because it inserts the fatal space itself, and the CLI needs
   `--json` rather than the `--symbols` its own `--help` recommends.
4. **The `-1100` error has two causes and one message.** A space after a comma, and a
   lowercase symbol.
5. **`exec`/`execFile` hang the Skill Hub CLI.** Spawn with stdin ignored.

### 4.11 Verify this whole section in about two minutes

```bash
curl https://www.omon-ai.duckdns.org/api/agent-os | jq .
curl https://www.omon-ai.duckdns.org/.well-known/x402 | jq '.agentOs.surfaces[] | {surface, status}'
curl https://www.omon-ai.duckdns.org/api/b402 | jq '{status: .b402.status, settling: .b402.settling}'

npx tsx scripts/skillhub-smoke.ts --verbose   # PASS only if the read came over an Agent OS rail
npx tsx scripts/mcp-smoke.ts --verbose        # FAILS on a silent REST fallback, by design
```

---

## 5. How it works, end to end

One beat, every five minutes, unattended. [`src/lib/tick.ts`](src/lib/tick.ts) is the
whole thing, and the console's manual button calls the exact same function, because a
demo button that runs different code from the scheduler proves nothing about the running
system.

| # | Step | Where |
|---|---|---|
| 1 | Pull headlines from RSS feeds. No key, no signup | [`src/lib/news.ts`](src/lib/news.ts) |
| 2 | **Intel Agent**: headline to `{assets, direction, confidence, thesis}` | [`src/lib/llm.ts`](src/lib/llm.ts) |
| 3 | Cache the intel, deduped, 5 minute TTL, durable across restarts | [`src/lib/intel-cache.ts`](src/lib/intel-cache.ts) |
| 4 | **Read Binance candles and prices through Agent OS** | [`src/lib/exchange.ts`](src/lib/exchange.ts) |
| 5 | Compute the chart half: regime, breakout, ATR, RSI, conviction | [`src/lib/strategy.ts`](src/lib/strategy.ts) |
| 6 | **Signal Agent**: news plus chart to a sized, venue-routed trade | [`src/lib/llm.ts`](src/lib/llm.ts) |
| 7 | Establish position facts *before* the verdict: what is held on spot, whether a futures order opens or closes | [`src/lib/tick.ts`](src/lib/tick.ts) |
| 8 | **Budget layer**: ALLOW, BLOCK or REQUIRE_APPROVAL. Recorded either way | [`src/lib/budget.ts`](src/lib/budget.ts) |
| 9 | On ALLOW only, place the order, record the **fill with its price**, update P&L | [`src/lib/pnl.ts`](src/lib/pnl.ts) |

**The beat is single-flight, and that is load-bearing rather than tidy.** The scheduler
firing while someone presses the console button would run two beats concurrently,
double-spend the model quota, and race two orders against one budget check. Overlapping
callers get the in-flight beat's result.

**`reduceOnly` is decided in step 7 and never taken from the model.** Whether an order
closes a position is a fact about the position, not an opinion the Signal Agent gets to
have.

---

## 6. The budget layer, the part with no model in it

[`src/lib/budget.ts`](src/lib/budget.ts). No model. No network. 28 tests.
**Model output is untrusted input, and `sizeUsd` is treated as hostile.**

| Control | Default | What it does |
|---|---|---|
| `maxTradeUsd` | 25 | Hard ceiling on any single trade |
| `dailyTradeUsd` | 100 | Rolling 24h ceiling, derived from the durable ledger rows |
| `allowedSymbols` | BNB, BTC, ETH | Nothing else is tradable, ever |
| `requireApprovalAboveUsd` | 25 | Above this, a human. This is usually the number that actually binds |
| `maxLeverage` | 3 | Hard cap, mirrored in the futures seam |

**Two rules that are safety properties rather than conveniences:**

1. **Closing is never blocked by the spending cap.** The cap counts trades that
   *increase* exposure and exempts the ones that reduce it. A cap that also throttles
   exits can leave an agent holding a position it is forbidden to close, which is a
   strictly more dangerous state than the one the cap was protecting against. **An agent
   must always be able to get out.**
2. **`sizeUsd` means notional on both venues.** $20 at 3x posts about $6.67 of margin
   and carries $20 of exposure. The cap checks the $20, so "$100 a day" means one thing
   on both venues, and leverage cannot quietly multiply it. Margin is reported alongside,
   never instead.

**A refusal that leaves no trace is indistinguishable from having no budget layer at
all**, so BLOCK is written to the durable ledger with the same weight as a fill, and the
console renders refusals in the same feed as orders. Force one live:

```bash
curl -X POST "https://www.omon-ai.duckdns.org/api/cron/tick?sizeUsd=500"
```

---

## 7. Getting paid: x402 and B402

Both agents' output is sold behind a real HTTP `402 Payment Required`. An outside agent
with nothing but the URL can discover the service, read the price, pay in USDC and get
the data. No account. No API key. No signup form.

```bash
node scripts/pay.mjs /api/intel     # an outside client pays a real 402
```

Settled, on chain, verifiable:

| Transaction | Chain |
|---|---|
| `0x2c0b06de25ebed4c4fb32863779dd26c56d9c787d1478a66cfd21f84902a9859` | Base Sepolia |
| `0xbe533fa76ce3f6b8fcf5b180e9d8a483cf0a3dafb5317bbea683fe65065d7266` | Base Sepolia |

### The Binance rail, and why it is honest about not settling

[`src/lib/b402.ts`](src/lib/b402.ts) maps Omon's payment challenge onto Binance
OnchainPay. Three rails, one seam:

```text
X402_RAIL=testnet        public facilitator, Base Sepolia.  Default.
X402_RAIL=b402-preview   B402 published and inspectable,    No credentials needed.
                         settles on the public rail.
X402_RAIL=b402           B402 settles on BSC.               Needs merchant credentials.
```

**The B402 rail looked finished before this work and it was not.** `paidRoute()` handed
B402 the same `price: "$0.01"` string the public rail takes, and the vendor's own
`B402ExactServerScheme.parsePrice` rejects a monetary price outright without a
`moneyParser`. `enhancePaymentRequirements` then demands `extra.assetTransferMethod`,
`extra.name` and `extra.version`, none of which were being sent. So the rail would have
**booted clean and failed on the first paid request**, which is the worst possible shape
for that bug: merchant credentials would have been blamed for a route-config gap, on the
day the credentials finally arrived.

That is now reproduced as a test **against the provider's own code**.
[`scripts/b402-test.ts`](scripts/b402-test.ts) asserts `parsePrice` **rejects** the old
form and **accepts** what `b402Accepts()` builds. 25 assertions, offline, no credentials.

**Preview mode keeps exactly one challenge payable.** The tempting version of featuring
a rail you cannot access is to advertise a BSC challenge and quietly settle elsewhere,
which hands a buyer a payment requirement it cannot pay on a chain nothing is watching.
Instead, preview publishes the B402 challenge **alongside** the one that really settles,
labelled `b402Preview`, built by the same `b402Accepts()` the live rail calls. What you
see in preview is byte for byte what a buyer would get on BSC. `settlementRail` is a
separate export from `rail`, so nothing that reports where money actually landed can
show "b402" over a figure that settled on Base Sepolia.

**What is genuinely blocked is one handshake.** `signerAddress` and `spenderAddress` are
**not set and must not be**: the facilitator supplies both per merchant from an RSA-gated
`/supported` endpoint that requires a Binance Pay merchant account, which requires a
business entity. A guessed value there is a wrong address inside a real payment
challenge. `/api/b402` reports the gap as a checklist of unset variable **names**, never
values.

---

## 8. Technical highlights: the five bugs worth your time

Not a feature list. These are the five findings that changed the architecture, and four
of them were money bugs.

**1. The scheduler was enforcing the daily cap twice, independently.**
`src/instrumentation.ts` is bundled into a **separate module graph** from the route
handlers, so anything it imports from `@/lib` is a *different instance*: its own ledger,
its own caches, its own budget arithmetic. The first heartbeat called `runTick()`
directly. Observed live: a scheduled beat **filled a real order** while every route still
reported `actionCount: 0`, and the scheduler's `spentTodayUsd()` read its own empty
ledger, so **real exposure was twice the configured limit**. The fix is a rule:
instrumentation holds a timer and a `fetch`, nothing else. It calls its own
`POST /api/cron/tick` over loopback, so all state stays in one graph and the heartbeat
behaves identically to an external cron.

**2. One signal was traded once per beat, not once.** The signal cache serves the same
newest row for its whole TTL, so consecutive beats inside that window each placed another
order. Observed: two beats a minute apart both filled BUY BTCUSDT off one signal. A quiet
news hour would have re-bought one stale idea until the daily cap was gone.
`ledger.hasTradedSignal()` now gates it, derived from the action rows rather than a
second counter, so only orders that actually reached the exchange count.

**3. The Signal Agent was being told to propose sizes the budget layer would always
refuse.** The prompt said "between 5 and 50" as a literal while `BUDGET_MAX_TRADE_USD`
was 25, and the next line told the model to size **up** on agreement. So the **strongest**
signals were precisely the ones refused, while the intel feed looked perfectly healthy. A
full day could run with zero fills and nothing obviously wrong on screen. The ceiling is
now derived from `limitsFromEnv()` so the two numbers cannot drift apart again.

**4. Restarting the process was a way to refill the budget.** Every piece of state was in
memory. `pm2 restart` reset the ledger, the P&L, both caches and the beat counter, which
meant a restart handed the agent a fresh daily allowance, let it re-trade an idea it had
already bought, and re-paid the model for headlines it had already analysed.
[`src/lib/store.ts`](src/lib/store.ts) is the fix: append-only JSONL for the ledger and
fills, whole-document JSON written to a temp file and renamed for the caches. **Appends
are synchronous on purpose**, because the failure being defended against is the process
dying between "Binance filled the order" and "the row reached the disk", and a lost fill
leaves an open position with no cost basis. Verified by **SIGKILL**, not a graceful
restart, with [`scripts/store-test.ts`](scripts/store-test.ts) spawning real second
processes: an earlier version of that test faked a restart by clearing the module cache
and **would have passed with persistence entirely removed**.

**5. There was no P&L, and there could not have been.** `recordAction()` stored what the
budget layer *decided*, and the order came back with `executedQty` and
`cummulativeQuoteQty` which were used for one console line and dropped on the floor. No
price meant no position, which meant no profit. [`src/lib/pnl.ts`](src/lib/pnl.ts) now
derives positions and profit from fills, with three decisions worth not re-litigating:
average cost rather than FIFO so a viewer can check it by hand; **selling what this
ledger never bought earns nothing** (the pre-funded BNB has no cost basis here, so it
goes in `unbasedSells` with an amber note rather than fabricating profit); and an open
position with no mark is **excluded and named**, because a missing price must read as
missing and never as a zero that looks like a loss.

**P&L is never netted against x402 revenue.** Different rails, USDC on Base Sepolia in
and demo USDT out, and one combined figure would imply a settlement between them that
does not exist. Two cards, side by side, each labelled with its own rail.

---

## 9. Quick start

Nothing here requires funding. Market reads need no credentials, Demo Mode is free, and
every seam falls back to recorded fixtures and **says so on screen** rather than
pretending.

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

**To get the live Binance Agent OS read rail** (optional, and free):

```bash
# install binance-cli from github.com/binance/binance-cli, then:
npx tsx scripts/skillhub-smoke.ts --verbose     # prices + candles, via: cli
```

**The keys, and what each is for.** All 38 are documented in
[`.env.example`](.env.example) with empty values. The four that change behaviour most:

| Key | Needed for | Without it |
|---|---|---|
| `GEMINI_API_KEY` | Both agents | Fixture intel and signals, labelled as fixtures |
| `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` | Order execution on Demo Mode | Prices still work; orders become fixture orders |
| `BINANCE_MCP_ACCESS_TOKEN` | The MCP read rail | Falls through to Skill Hub, then REST, and reports it |
| `X402_RAIL` | Which payment rail | Defaults to the public facilitator on Base Sepolia |

---

## 10. Verify every claim on this page

Every one of these runs without credentials unless marked.

| Claim | Command | Expected |
|---|---|---|
| The budget layer is real | `npx tsx scripts/budget-test.ts` | **28 passed** |
| The P&L math is right | `npx tsx scripts/pnl-test.ts` | **26 passed** |
| The B402 mapping is right | `npx tsx scripts/b402-test.ts` | **25 passed** |
| Futures sizing is right | `npx tsx scripts/futures-test.ts` | **9 passed** |
| State survives a SIGKILL | `npx tsx scripts/store-test.ts` | **12 passed**, spawns real processes |
| The indicator port is exact | `npx tsx scripts/indicators-test.ts <path>` | Matches the original over 19,980 bars |
| Agent OS is actually serving | `npx tsx scripts/skillhub-smoke.ts --verbose` | `via: "cli"` |
| MCP is not silently faked | `npx tsx scripts/mcp-smoke.ts --verbose` | Fails on a REST fallback, by design |
| A stranger's agent can discover and pay | `npx tsx scripts/discovery-smoke.ts` | 21 checks |
| The console shows what the system did | `npx tsx scripts/console-smoke.ts --tick` | 17 checks, drives a live beat |
| An outside client can pay a 402 | `node scripts/pay.mjs /api/intel` | A settled transaction |

**100 offline assertions, all green, run immediately before this README was written.**

---

## 11. Repo map

```
src/lib/mcp.ts          Binance MCP (Agent OS). JSON-RPC over Streamable HTTP, OAuth
                        + PKCE + CIMD, tool resolution. READ ONLY BY DESIGN.
src/lib/skillhub.ts     Binance Skill Hub (Agent OS). binance-cli, spawned. The rail
                        that actually serves. Batched reads, 3.3x.
src/lib/exchange.ts     The three-rail read stack and spot execution. The only file
                        that talks to the Binance spot host.
src/lib/futures.ts      USDⓈ-M perpetuals. Signed positions, stepSize rounding,
                        reduceOnly, notional-not-margin.
src/lib/b402.ts         Binance OnchainPay mapping: atomic-unit pricing, the extra{}
                        fields the B402 scheme demands, credential-free readiness.
src/lib/x402.ts         The payment seam. The only file routes import for payment.
src/lib/budget.ts       The leash. No model, no network. 28 tests.
src/lib/strategy.ts     Trend, breakout, conviction. The chart half of every signal.
src/lib/indicators.ts   EMA/ATR/RSI/priorRange. Pure math, cross-checked bar for bar.
src/lib/llm.ts          Both agents. Gemini structured output, ceiling from the budget.
src/lib/tick.ts         One beat of the whole system. Single-flight. Venue routing.
src/lib/scheduler.ts    The heartbeat's config and reported state. Holds no timer.
src/lib/store.ts        Durable JSONL + whole-doc JSON. Never throws. Never fatal.
src/lib/ledger.ts       Money in, money out, and fills. The budget's source of truth.
src/lib/pnl.ts          Positions and profit from fills. Average cost. Pure functions.
src/lib/service.ts      What Omon sells, machine-readable. Feeds the manifest AND the
                        402 preview, so the two cannot drift.
src/lib/console-state.ts One cheap snapshot of everything the screen shows, every 2s.

src/app/page.tsx                  The console.
src/app/api/agent-os/route.ts     Free. Per-seam Agent OS status. Never the token.
src/app/api/manifest/route.ts     Free. Aliased to /.well-known/x402.
src/app/api/b402/route.ts         Free. B402 rail state. Never a credential value.
src/app/api/oauth-client/route.ts Our OAuth client metadata. This URL IS our client_id.
src/app/api/intel/route.ts        PAID. Real 402.
src/app/api/signals/route.ts      PAID. Real 402.
src/app/api/cron/tick/route.ts    POST runs one beat, GET reports the last one.
src/app/api/stream/route.ts       SSE. One full snapshot every 2s.

src/instrumentation.ts  The heartbeat. Holds a timer and a fetch, and NOTHING ELSE.
                        See section 8, bug 1, before changing this.
```

**Seam discipline:** `src/lib/*.ts` are the only files that talk to the outside world.
Routes and components call seams; they never call an SDK or a URL directly. That is what
makes the fixture fallback work, and it is why swapping in the Skill Hub rail took hours
rather than days.

**Every seam reports its own mode.** `mcpMode()`, `cliMode()`, `llmMode()`,
`exchangeMode()`, `futuresMode()`, and each one returns `{mode, reason}`. Nothing on
screen is ever a guess about whether something was live.

---

## 12. Limitations, and what is next

### Built and running

- Two model-driven agents, unattended, every five minutes, on a public origin.
- Market reads on Binance Agent OS through the Skill Hub rail, with MCP wired ahead of
  it and REST beneath it, and the rail actually used published on every read.
- Spot execution on Demo Mode and perpetual execution on the futures testnet, both with
  real fills.
- A budget layer with no model in it, 28 tests, and refusals recorded as first-class
  events.
- Durable state that survives a SIGKILL, with P&L derived from real fill prices.
- Both agents' output sold behind a real HTTP 402, settled on chain, discoverable
  without a directory.
- The B402 rail mapped against the vendor SDK, published, and inspectable for free.

### Next

- **The MCP allowlist.** The client is complete. This needs Binance to allowlist a
  `client_id`, which is a decision rather than a build.
- **B402 live settlement.** Blocked on one RSA-gated handshake that needs a merchant
  account.
- **A second buyer.** The paid endpoints work and have been paid; revenue is a
  demonstration rather than a business.
- **Pre-existing positions.** The P&L knows what this ledger bought. Balances that
  predate it are named as unbased rather than silently valued.

### Vision

An agent that funds its own operation by selling what it learns is a different economic
object from an agent that spends a budget. Omon is one datapoint that the pieces now
exist: Binance Agent OS on the read and execution side, an open payment standard on the
revenue side, and plain code in between deciding what the model is allowed to do with
either.

### Known gaps, stated plainly

- The MCP rail reports `not connected` and will keep reporting it until the allowlist
  changes. Nothing on screen claims otherwise.
- Payments settle on Base Sepolia in test USDC, not mainnet.
- Orders execute against real matching engines with demo funds. No real money has moved
  through this project.
- There is no multi-user story. One operator, one set of limits.
