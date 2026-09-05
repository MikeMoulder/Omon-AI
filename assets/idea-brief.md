# Idea brief — Omon

*Rewritten 2026-09-04, evening. Supersedes everything in `draft.md` and the earlier
"permissioned treasury operator" version of this file.*
*Deadline 2026-09-08 23:59 UTC. Solo. ~28 build hours left.*
*Submission theme: **Payment Workflows**.*

## The sentence

> We built **Omon** for **AI agents that need market intelligence they can act on**,
> letting them **buy it per call in USDT with no account and no API key**, using
> **Binance x402 and MCP** to make **an agent that earns its own income and trades on
> what it knows** possible.

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
and places the trade on a Binance Agentic sub-account.

Both agents sell their output to outside agents over paid HTTP endpoints. Between the
Signal Agent and Binance sits a budget layer written in plain code, so the model proposes
trades but never authorizes them.

Omon earns money from other agents. It spends money on trades. Both directions are real
and both are on screen.

## Why now

Three things landed in the last eight weeks and none of them existed a year ago:

- **Binance MCP** (20 Aug 2026) — an agent can place a real order on a scoped sub-account.
- **Binance x402 / b402** (Jul 2026) — an HTTP endpoint can charge per call, settled in
  USDT, with the buyer needing no gas and no account.
- **B402 Bazaar** — a discovery layer where any agent can *find* paid endpoints without
  anyone pre-configuring a list.

Selling to a machine that finds you on its own and pays you per request was not possible
before this. That is the whole project.

## Why this technology

| Technology | Used for | Depth | Remove it and… |
|---|---|---|---|
| **x402 (open standard)** | The paid endpoints. HTTP 402, off-chain signature, USDC settled on Base Sepolia, gas covered by the facilitator | Essential | There is no product. Agents cannot buy anything and Omon has no income |
| ~~**Binance x402 / b402**~~ | ~~Same, on BNB Chain~~ | **UNAVAILABLE** — the B402 merchant rail requires an Entity (business) Binance account. Confirmed 2026-09-04, see `assets/spike-notes.md`. Code seam is built and switches with one env var if that ever changes | — |
| ~~**B402 Bazaar**~~ | ~~Discovery~~ | **UNAVAILABLE** — Bazaar indexes off a confirmed B402 settle, which needs the merchant rail. Hand Claude Desktop the URL directly instead | — |
| **Binance MCP** | Live prices, sub-account balances, placing the actual spot order | Essential | The signal is an opinion nobody acted on. No trade, no proof |
| **Agentic sub-account** | The scoped account the orders hit. Withdrawals blocked by Binance | Valuable | Live trading gets unsafe, and the safety answer in Q&A gets weaker |

Every live row is Essential or Valuable. Two rows were struck on 2026-09-04 when
merchant onboarding turned out to need a business entity — the payment rail is the
open x402 standard instead of Binance's own. Binance MCP is now the load-bearing
Binance integration: live prices and the real order.

## The aha moment

**At 0:25 the judge sees:** Claude Desktop — a client we did not write — searching B402
Bazaar, finding Omon, getting an HTTP 402, paying in USDT, and receiving the intelligence.
The payment lands on Omon's screen while it happens.

**Why it lands:** *unexpected* and *legible*. Everyone at this hackathon built an agent
that spends. Almost nobody built one that **gets paid**. And the buyer is visibly a
third-party app, not our own code, which is the objection it answers before anyone raises it.

## Demo script

Target 2:15. X video, watched on a phone. Split screen: Claude Desktop left, Omon right.

| Time | What you do | What appears | What the system is doing |
|---|---|---|---|
| 0:00 | One line: "This agent sells market intelligence to other AI agents, and trades on what it knows." | Omon console. Intel feed, empty wallet, budget meter | Cold open. No title card |
| 0:10 | — | A headline lands, and becomes structured intel: assets, direction, confidence | Cron: news → LLM → `intel` row |
| 0:25 | **THE AHA.** In Claude Desktop: "find crypto intel I can buy, and buy it" | Claude searches Bazaar → finds Omon → **402** → signs → pays. **Omon's balance moves.** | b402 facilitator verifies and settles USDT on BSC testnet |
| 0:55 | Nothing. Let it run | Signal appears with its reasoning, tied back to the headline | Intel + MCP prices → LLM → `signals` row |
| 1:10 | — | Budget check passes → **real Binance order id appears** | Budget layer allows → MCP places the spot order |
| 1:30 | In Claude Desktop: "now buy the signal" | Second payment lands. Two income events on screen | `/api/signals` → 402 → paid |
| 1:50 | Ask for a trade that is too big | **BLOCKED.** Nothing moves. Reason shown | Budget layer denies. The model proposed; the code refused |
| 2:05 | — | Wallet: money in from two agents. Orders: one real trade out | Closing line: "It pays for itself." |

**It ends on money, not on a refusal.** The block is the last beat, not the climax.

**Fallback:** record a clean take with real payment tx hashes and a real order id. If
anything 500s live, that take is the submission, and the README says which parts are live.

**Say "BSC testnet" and "demo sub-account" in the first twenty seconds.** A Binance
engineer spots a testnet tx hash instantly. Saying it costs nothing; hiding it is fatal.

## MVP

```text
MUST HAVE     — the aha cannot happen without these
  - /api/intel behind a real b402 402 challenge, payable from an outside client
  - Intel Agent: headlines -> {assets, direction, confidence, thesis}
  - Signal Agent: intel + MCP prices -> {symbol, side, size, thesis}
  - Budget layer in plain code: ALLOW / BLOCK, enforced before execution
  - One real spot order on the Binance Agentic sub-account, with its order id on screen
  - ONE screen: intel feed, payments in, orders out, budget meter
  - The 2:15 video

SHOULD HAVE   — only after every MUST is deployed
  - /api/signals as a second paid endpoint
  - B402 Bazaar registration so Claude finds it by search instead of by URL
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
Riskiest component:          The b402 seller side. Everything depends on one route
                             returning a 402 that an outside client can actually pay.
                             Spike it tonight, before any feature code.
```

## Risks

| Risk | If it happens | Mitigation |
|---|---|---|
| **Technical** | b402 seller integration is harder than the docs suggest | Fall back to a plain USDT transfer between two wallets. Still agent-to-agent; drop the "402" wording |
| **Technical** | Official Binance MCP has no paper mode (unconfirmed — docs would not load) | Fund the Agentic sub-account with ~$20. Binance blocks external withdrawals, so that is the ceiling on loss |
| **Product** | "Why would an agent pay for your news summary?" | Answered below |
| **Demo** | No outside agent buys during the video | You are the outside agent, through Claude Desktop. That is legitimate — it is a client you did not write |
| **Demo** | Tick exceeds the serverless timeout in production but not locally | Cron writes rows, SSE reads them. Already the design. Deploy at hour one to catch it |

## The hard question

**They will ask:** "Why would any agent pay for this? It can read the news itself."

**You answer:** "It can read the news. It can't act on it. What it needs is
`{asset, direction, confidence}` it can route straight into a strategy — and it needs to
get that without a signup form, an API key or a card on file, because it's an agent. That
combination didn't exist before x402. We're not selling news; we're selling the one
structured field an autonomous buyer can use, priced per call. And we eat our own output —
the same intel drives a real trade you can look up on Binance."

**What is hardcoded:** [fill this in on day 3, before the video]

Known and disclosed from the start:
- Payments settle on **Base Sepolia** via the public x402 facilitator, not
  Binance's B402 rail. B402 needs a business merchant account.
- Trading runs on a **Binance Agentic sub-account** funded small, not a real treasury.
- News comes from a fixed source list.

## Tracks targeted

| Track | Prize | Why we qualify | Depth |
|---|---|---|---|
| **Track A — Payment Workflows** | 2,000 / 1,500 / 1,000 + 50 x 300 | Agent-to-agent payments are the product, not a feature. Also covers Data Analysis and Trading Workflows, but Payment is the emptiest category and the truest fit | rung 4 — built for x402, not with it added |
| **Track B — MCP completion** | 4 USDC | Spot, futures and convert through the same MCP connection Track A needs | Do it in tonight's spike as the smoke test |

## Handoff

```text
demo.hero_screen — The console. Intel feed on the left; money in (payments) and money out
                   (orders) on the right, with the balance large and animated. The moment
                   a payment lands must be impossible to miss — that is the aha.
Architecture     — assets/architecture-brief.md (already written)
Next             — spike tonight, then /skillz:frontend with src/lib/types.ts
```
