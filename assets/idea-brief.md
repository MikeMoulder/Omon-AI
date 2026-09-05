# Idea brief — Omon

*Rewritten 2026-09-04, evening. Supersedes everything in `draft.md` and the earlier
"permissioned treasury operator" version of this file.*
*Deadline 2026-09-08 23:59 UTC. Solo. ~28 build hours left.*
*Submission theme: **Payment Workflows**.*

## The sentence

> We built **Omon** for **AI agents that need market intelligence they can act on**,
> letting them **buy it per call in USDC with no account, no signup and no API key**,
> using **the open x402 standard and Binance MCP** to make **an agent that earns its
> own income and trades on what it knows** possible.

## Problem

**Who:** Anyone running a trading agent — including the people at this hackathon.

**Pain:** An agent that wants market intelligence has to sign up for a service, get an
API key, put a card on file, and hope the output is machine-readable. None of that works
for an autonomous agent. It cannot fill in a signup form. So agents scrape raw headlines
and try to reason about them from scratch, badly, every single time.

**Evidence:** Binance shipped x402 and B402 Bazaar in July 2026 for exactly this — agents
paying for services with no prepaid subscription and no key management. They built the
rail. Almost nothing is on it yet.

## Solution

Omon is one system with two agents inside it.

The **Intel Agent** watches news and turns it into structured, actionable market
intelligence — which assets, which direction, how confident, and why. The **Signal Agent**
takes that intelligence, combines it with live Binance prices, produces a trade signal,
and places the trade on Binance Spot Demo Mode.

Both agents sell their output to outside agents over paid HTTP endpoints. Between the
Signal Agent and Binance sits a budget layer written in plain code, so the model proposes
trades but never authorizes them.

Omon earns money from other agents. It spends money on trades. Both directions are real
and both are on screen.

## Why now

Three things landed in the last eight weeks and none of them existed a year ago:

- **Binance MCP** (20 Aug 2026) — an agent can place a real order on a scoped sub-account.
- **x402** (2025-26, and Binance's own b402 in Jul 2026) — an HTTP endpoint can charge
  per call, settled in stablecoin, with the buyer needing no account and no gas.
- **Machine-readable service discovery** — an agent handed only a URL can read what is
  for sale, what it costs and which chain settles it, then pay, with no human in between.

Selling to a machine that arrives on its own and pays you per request was not possible
before this. That is the whole project.

> **On B402 Bazaar:** Binance's own discovery directory is *not* part of this build.
> Listing there is gated on a Binance Pay merchant account, which requires a business
> entity (`assets/spike-notes.md`). Omon is therefore **unlisted but pluggable**: it
> publishes its own catalogue at `/.well-known/x402`, which is what a directory entry
> would have contained. See "Discovery without a directory" below.

## Why this technology

| Technology | Used for | Depth | Remove it and… |
|---|---|---|---|
| **x402 (open standard)** | The paid endpoints. HTTP 402, off-chain signature, USDC settled on Base Sepolia, gas covered by the facilitator | Essential | There is no product. Agents cannot buy anything and Omon has no income |
| ~~**Binance x402 / b402**~~ | ~~Same, on BNB Chain~~ | **UNAVAILABLE** — the B402 merchant rail requires an Entity (business) Binance account. Confirmed 2026-09-04, see `assets/spike-notes.md`. Code seam is built and switches with one env var if that ever changes | — |
| **Self-published discovery** | `/.well-known/x402` — a free catalogue naming the service, its tags, price, chain, payee and response shapes. The 402 challenge carries the same metadata plus a redacted sample | Valuable | An agent handed the URL learns nothing and cannot decide whether to buy. Replaces the Bazaar listing we cannot have |
| ~~**B402 Bazaar**~~ | ~~Discovery~~ | **UNAVAILABLE** — Bazaar indexes off a confirmed B402 settle, which needs the merchant rail. Omon publishes its own catalogue instead | — |
| **Binance MCP** | Every market read: live prices, and the OHLCV candles the technical engine runs on, plus account state. `spot_tickerPrice`, `spot_klines`, `spot_getAccount`, over OAuth. **Reads only — orders do not go through MCP** (see the Spot Demo Mode row for why) | Essential | The chart half of every signal loses its data source. Omon degrades to news-only opinion |
| **Spot Demo Mode** | The account the orders actually hit — `demo-api.binance.com`, real matching engine, demo funds. Chosen over Spot Testnet because it mirrors the live exchange and is Binance's own branded product. **This is why orders do not run over MCP:** the MCP token authorises the operator's real account, so an order placed there would spend real money | Valuable | Trading gets unsafe or costs real money, and the safety answer in Q&A gets weaker |

Every live row is Essential or Valuable. Two rows were struck on 2026-09-04 when
merchant onboarding turned out to need a business entity — the payment rail is the
open x402 standard instead of Binance's own.

**Two Binance Agent OS surfaces carry this project, and the split between them is
deliberate:** every market read goes through the **Binance MCP server** — including
the candles the ported ren-ai indicator engine computes on, so Agent OS data drives
the analysis rather than decorating a price label — while **order execution** goes
through the **Binance Exchange API on Spot Demo Mode**. Reads are free and safe on
a real account; writes are not. `npx tsx scripts/mcp-smoke.ts` proves the MCP half,
and `GET /api/agent-os` reports it live, including when the connection is down.

*Corrected 2026-09-05. An earlier version of this row claimed MCP placed the spot
order. It never did, and it should not.*

## The aha moment

**At 0:25 the judge sees:** an outside client — one we did not write — reading Omon's
`/.well-known/x402` catalogue, following it to the paid endpoint, getting an HTTP 402,
paying in USDC, and receiving the intelligence. The payment lands on Omon's screen while
it happens.

**Why it lands:** *unexpected* and *legible*. Everyone at this hackathon built an agent
that spends. Almost nobody built one that **gets paid**. And the buyer is visibly a
third-party app, not our own code, which is the objection it answers before anyone raises it.

## Demo script

Target 2:15. X video, watched on a phone. Split screen: Claude Desktop left, Omon right.

| Time | What you do | What appears | What the system is doing |
|---|---|---|---|
| 0:00 | One line: "This agent sells market intelligence to other AI agents, and trades on what it knows." | Omon console. Intel feed, empty wallet, budget meter | Cold open. No title card |
| 0:10 | — | A headline lands, and becomes structured intel: assets, direction, confidence | Cron: news → LLM → `intel` row |
| 0:25 | **THE AHA.** Point an outside agent at Omon's URL: "find what this sells, and buy it" | It reads `/.well-known/x402` → follows it to `/api/intel` → **402** → signs → pays. **Omon's balance moves.** | x402 facilitator verifies and settles USDC on Base Sepolia |
| 0:55 | Nothing. Let it run | Signal appears with its reasoning, tied back to the headline | Intel + MCP prices → LLM → `signals` row |
| 1:10 | — | Budget check passes → **real Binance order id appears** | Budget layer allows → MCP places the spot order |
| 1:30 | In Claude Desktop: "now buy the signal" | Second payment lands. Two income events on screen | `/api/signals` → 402 → paid |
| 1:50 | Ask for a trade that is too big | **BLOCKED.** Nothing moves. Reason shown | Budget layer denies. The model proposed; the code refused |
| 2:05 | — | Wallet: money in from two agents. Orders: one real trade out | Closing line: "It pays for itself." |

**It ends on money, not on a refusal.** The block is the last beat, not the climax.

**Fallback:** record a clean take with real payment tx hashes and a real order id. If
anything 500s live, that take is the submission, and the README says which parts are live.

**Say "Base Sepolia" and "Binance Spot Demo Mode" in the first twenty seconds.** A
Binance engineer spots a testnet tx hash instantly. Saying it costs nothing; hiding it is
fatal. Do **not** say Bazaar, B402 or marketplace — none of them are wired.

## MVP

```text
MUST HAVE     — the aha cannot happen without these
  - /api/intel behind a real x402 402 challenge, payable from an outside client
  - /.well-known/x402 so an agent handed only the URL can find and price the service
  - Intel Agent: headlines -> {assets, direction, confidence, thesis}
  - Signal Agent: intel + MCP prices -> {symbol, side, size, thesis}
  - Budget layer in plain code: ALLOW / BLOCK, enforced before execution
  - One real spot order on Binance Spot Demo Mode, with its order id on screen
  - ONE screen: intel feed, payments in, orders out, budget meter
  - The 2:15 video

SHOULD HAVE   — only after every MUST is deployed
  - /api/signals as a second paid endpoint
  - The BLOCKED beat

NICE TO HAVE  — you will not be ahead
  - Price that moves with confidence score
  - A second news source

CUT           — decided, not re-argued at 4am
  - The Treasury / yield agent. MCP has NO Earn or staking scope. The rail does not
    exist. README roadmap line, nothing more
  - Reputation layer / win-rate scoreboard. Four days is not a track record
  - "Agent marketplace" framing. Two endpoints is a pipeline. Bazaar is the marketplace
  - Human approval flow. BLOCK carries the point alone
  - Futures and margin beyond the three orders Track B needs
  - Auth, onboarding, landing page, multi-user, backtesting, Docker
```

## Scope check

```text
Build hours available:       28
Honest estimate for MUST:    22
Ratio:                       0.79  -- over the 0.5 rule. Accepted, on two conditions:
                                      1. nothing from SHOULD is planned, only promoted
                                      2. one screen, shadcn defaults, no custom design
Riskiest component:          RESOLVED. The seller side works on the open x402 rail --
                             an outside client pays a real 402 and settles in ~1.3s.
                             Proven 2026-09-04, re-proven 2026-09-05.
```

## Risks

| Risk | If it happens | Mitigation |
|---|---|---|
| ~~**Technical**~~ | ~~b402 seller integration is harder than the docs suggest~~ | **RETIRED** — the open x402 rail works end to end. B402 is unreachable without a business entity, so it is not on the critical path at all |
| ~~**Technical**~~ | ~~Binance MCP has no paper mode~~ | **RETIRED** — orders run on Binance **Spot Demo Mode** (`demo-api.binance.com`), a real matching engine with demo funds. No real money is needed and none should be added |
| **Product** | "Why would an agent pay for your news summary?" | Answered below |
| **Demo** | No outside agent buys during the video | You drive the outside agent yourself. `scripts/pay.mjs` is a separate client, out of process, that discovers and pays exactly as a stranger's agent would. Do not call it "Claude Desktop" unless that is proven — see Open questions in `handoff.md` |
| **Demo** | Tick exceeds the serverless timeout in production but not locally | Cron writes rows, SSE reads them. Already the design. Deploy at hour one to catch it |

## The hard question

**They will ask:** "Why would any agent pay for this? It can read the news itself."

**You answer:** "It can read the news. It can't act on it. What it needs is
`{asset, direction, confidence}` it can route straight into a strategy — and it needs to
get that without a signup form, an API key or a card on file, because it's an agent. That
combination didn't exist before x402. We're not selling news; we're selling the one
structured field an autonomous buyer can use, priced per call. And we eat our own output —
the same intel drives a real trade you can look up on Binance."

**What is hardcoded:** nothing in the intel path any more. News is pulled live from
Cointelegraph and CoinDesk RSS, analysed by the model, and cached for 5 minutes.
Fixtures still exist behind every seam as the offline fallback, and each seam reports
which mode it is in.

Known and disclosed from the start:
- Payments settle in **test USDC on Base Sepolia** via the public x402 facilitator, not
  Binance's B402 rail. B402 needs a business merchant account.
- Trading runs on **Binance Spot Demo Mode** — a real matching engine with demo funds,
  not a real treasury and not real money.
- Omon is **not listed in any directory**. It publishes its own catalogue instead.
- News comes from a fixed source list of two RSS feeds.

## Tracks targeted

| Track | Prize | Why we qualify | Depth |
|---|---|---|---|
| **Track A — Payment Workflows** | 2,000 / 1,500 / 1,000 + 50 x 300 | Agent-to-agent payments are the product, not a feature. Also covers Data Analysis and Trading Workflows, but Payment is the emptiest category and the truest fit | rung 4 — built for x402, not with it added |
| ~~**Track B — MCP completion**~~ | ~~4 USDC~~ | **DROPPED** — needs real funded trades. Track A's prize pool is what matters | — |

## Handoff

```text
demo.hero_screen — The console. Intel feed on the left; money in (payments) and money out
                   (orders) on the right, with the balance large and animated. The moment
                   a payment lands must be impossible to miss — that is the aha.
Architecture     — assets/architecture-brief.md
State of play    — handoff.md is the live document. This brief is the pitch; handoff.md
                   is what is actually built. When they disagree, handoff.md is right.
Next             — the trade half of the tick, then the console
```

## Discovery without a directory

Omon cannot be listed in B402 Bazaar, so it carries its own listing. This is a
deliberate design answer, not a workaround apology, and it is checked by
`npx tsx scripts/discovery-smoke.ts` — 21 assertions walking the exact path a
stranger's agent walks.

| Surface | What it gives an agent that has only the URL |
|---|---|
| `GET /.well-known/x402` | Free catalogue: service name, tags, description, price, chain, payee, every endpoint with its response shape, and a plain statement that the rail is a testnet |
| `GET /api/manifest` | The same document at its canonical path |
| `402` on `/api/intel` | Price, chain, payee, how to pay, a pointer back to the manifest, and a **redacted sample row** — real headline, assets and direction, with `summary` and `confidence` withheld as `[paid]` |

The pitch line: *an agent needs no account, no API key and no directory entry —
only the URL.*
