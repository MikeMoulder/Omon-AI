# Judge scorecard — Omon

*Reviewed 2026-09-05, T-83h wall clock / ~22 honest build hours. Depth: FULL, hostile.*
*Rubric source: **inferred**. Binance published no weights; these are `hackathon.yml`'s.
A judge may weight this differently — treat the consensus as directional, not exact.*

**Judged from artifacts only:** the repo as pushed, the routes as they respond, the
README as written. Not from what the handoff says works.

## Panel

```text
PANEL              score  conf    note
Product              6.5  high    sharp thesis, no artifact anyone can touch
Technical            7.5  high    real library work — and half of it is unpushed
Sponsor              3.5  high    Decorative on Agent OS / MCP
Demo                 2.0  high    nothing exists to record
                    ----
Consensus            5.2          Weak-to-competitive
```

**Disagreement — Technical 7.5 vs Sponsor 3.5.** This is the whole review. The
engineering is above the hackathon median: verified indicator port, working 402
settlement, clean seams, 16 passing budget tests. Almost none of it is *Binance*
engineering. At an event called "Build an AI agent with Agent OS", the sponsor's
own technology appears in the shipped product exactly zero times. Strong build,
pointed away from the prize.

**Second disagreement — Product 6.5 vs Demo 2.0.** The pitch ("everyone built an
agent that spends; almost nobody built one that gets paid") is genuinely good and
genuinely differentiated. There is no screen on which to show it.

**Readiness: NOT READY.** Track A's one mandatory artifact — the video — does not
exist, and the autonomous loop it would show does not run.

## Requirements

| Requirement | Mandatory | Status | Evidence | Severity |
|---|---|---|---|---|
| Demo video of the agent running | Yes | **FAIL** | not started; `handoff.md` §2 "NOT BUILT" | CRITICAL |
| GitHub link | Yes | PARTIAL | repo pushed, but `origin/main` = `92fa767` is **stale** | CRITICAL |
| Public repo readable by a stranger | Yes | **FAIL** | `README.md` is the create-next-app default, committed and pushed | HIGH |
| Built with Agent OS | Yes | **PARTIAL** | no MCP call anywhere in `src/`; only `.mcp.json` (6 lines, IDE config) | CRITICAL |
| Follow @binance + repost + reply | Yes | UNKNOWN | external to the repo — not verifiable here | CRITICAL |
| Official Binance survey completed | Yes | UNKNOWN | external — not verifiable here | CRITICAL |
| Regional eligibility | Yes | PASS | user-confirmed 2026-09-04, `hackathon.yml` | — |
| Repo visibility is public | Yes | UNKNOWN | `github.com/MikeMoulder/Omon-AI` — **click it logged out** | HIGH |

```text
1 PASS    2 PARTIAL    2 FAIL    3 UNKNOWN
```

The three UNKNOWNs are the X steps and the survey. They are not code, they take
fifteen minutes, and every year they are how projects with working software get
disqualified. Do them before writing another line.

## If this loses, why

```text
FATAL
  1. No video. Track A's minimum submission is "demo video of the agent running."
     There is no agent running to film: no console, no tick, page.tsx is still the
     Next.js template. This is the whole submission, not a polish item.

  2. Agent OS is not in the product. The hackathon is named for it. A judge greps
     for MCP and finds .mcp.json — six lines pointing *Claude Code* at Binance's
     server. That is the builder's IDE, not the artifact. src/lib/exchange.ts is
     hand-rolled REST + HMAC against demo-api.binance.com. Every crypto project
     has that. In a Payment Workflows track the payment rail is Base Sepolia, not
     Binance's B402 — defensible, and documented, but it means nothing distinctive
     in this project is Binance.

  3. The pushed repo is stale. origin/main lacks indicators.ts, strategy.ts,
     service.ts, the manifest route and three smoke scripts — i.e. the verified
     ren-ai port and the discovery manifest, the two most impressive things here.
     Judged today, they do not exist.

SERIOUS
  4. README is create-next-app boilerplate, committed and public. The first click
     after the video says "bootstrapped with create-next-app."

  5. Claim gap on MCP. assets/idea-brief.md still grades Binance MCP "Essential —
     live prices, sub-account balances, placing the actual spot order." None of
     those go through MCP. handoff.md §8 already corrects the order half; the
     brief was never updated, and the price half is wrong too — getPrices() calls
     /api/v3/ticker/price directly. If this line reaches the video or the survey,
     it is a fabricated integration claim, which is worse than having none.

  6. No autonomous loop. The tick's trade half is unbuilt. Nothing happens unless
     a human runs `npx tsx`. "An agent that earns its own income and trades on
     what it knows" is, as shipped, a library plus three routes plus smoke scripts.

MODERATE
  7. Cold start serves fixtures on the judge path. No persistence, so on Vercel
     every cold start answers the 402 preview with
     https://example.com/treasury-stablecoin-delay. Verified live just now. This
     is exactly the silent-fixture trap handoff.md §6 warns about, now sitting on
     the one URL a curious judge will probe.

  8. "An outside client — one we did not write" (idea-brief, the aha moment) is
     scripts/pay.mjs, 37 lines, in this repo. Out-of-process is a real and fair
     distinction. "We did not write it" is not true and should not be said aloud.

  9. Internal docs are public. handoff.md, updated_convo_with_codex.md and
     what_is_agentOS.md are committed. handoff.md lists every unbuilt piece and
     the note "Do not claim the trade was placed through Binance MCP." A fair
     judge reads discipline; a hostile one reads a confession, pre-indexed.

MINOR
 10. Default favicon, no page title, no og image.
 11. X402_RAIL=b402 without credentials 500s the paid route — already known and
     documented, but check the env var before recording.
```

## Why this wins

**Defensible advantage: the seller side.** Almost every entry at this event is an
agent that spends money. Omon is an agent with revenue, and the plumbing is real:
a working 402 challenge, settled USDC (tx `0x2c0b06de…`, 1.26s), and a
self-published `/.well-known/x402` catalogue with response shapes, a redacted
paid preview, and an honest `disclosure` field naming the testnet. Verified live
during this review — manifest 200, `/api/intel` 402 with a complete challenge.
A team could copy the idea by Sunday; they could not copy a settled transaction.

1. **The discovery manifest is better than it needs to be.** Marking `/api/signals`
   `"status": "planned"` instead of hiding it is the kind of honesty that reads as
   competence. 21 assertions walk the stranger's path.
2. **The confluence finding is real analysis, honestly bounded.** 42 logged trades,
   aligned 54% / +$1,444 vs neutral 36% / −$1,181, with n=11 stated out loud. The
   indicator port is checked bar-for-bar on 19,980 bars. That is a defensible
   answer to "was anything here hard?" — if a judge can find it, which today they
   cannot, because it is not pushed.

## Fixes

```text
Honest build hours remaining: ~22        Fix budget: 11h
(83h wall clock, but solo and sleeping. Budget the real number.)

FIXING
  P0  Push everything + rewrite README         1.5h  cheapest catastrophic loss on
                                                     the board. Best work is not
                                                     even on GitHub. Lead with the
                                                     live/demo/testnet table from
                                                     handoff.md §8
  P0  Console + the tick's trade half          6.0h  without a screen there is no
                                                     video and no "agent". This is
                                                     the product, not a feature
  P0  Record the 2:15 video                    2.0h  mandatory. Includes retakes
  P1  Put MCP on one real product path         1.5h  route getPrices through the
                                                     Binance MCP server. If
                                                     server-side auth fails, show
                                                     MCP in the video via Claude
                                                     Code and say exactly what it
                                                     does and does not do
                                               ----
                                        total  11.0h

  Free, do first (15 min, not from the budget):
    - Follow / repost / reply on X, and the Binance survey
    - Open the GitHub URL in a logged-out window
    - Fix the idea-brief MCP row before it reaches the survey

NOT FIXING (decided, do not revisit)
  Postgres / Drizzle persistence   in-memory + a warm cache survives 2:15. A JSON
                                   file if the cold-start fixture shows on camera
  /api/signals second endpoint     the manifest already says "planned". One paid
                                   endpoint proves the rail; two prove nothing more
  The BLOCKED beat as new code     budget.ts already does this and is tested. It is
                                   a video beat, not a build item. Costs 0h — keep it
  Track B, futures, margin         needs real funds. Dropped, correctly
  Mobile layout, auth, tests       nobody scores these
```

One decision worth 15 minutes, not a reopening: `binance-cli` was cut partly for
"no Windows binary." Vercel runs Linux, so that half does not apply to the deploy
target. If MCP server-side auth fails, the Skill Hub CLI is the other route to a
real Agent OS integration.

## The question you cannot answer

**They will ask:** "This is the Agent OS hackathon. Show me where your agent uses
Agent OS."

**Current answer, honestly:** "I connected the MCP server in my IDE while building,
and the trades go through the Binance REST API on Spot Demo Mode." That is a
losing answer in this specific room. It concedes that the sponsor's platform was a
development convenience, not a dependency.

**Better answer:** "Live prices and account state come through the Binance MCP
server — here is the call. Orders execute against Binance Spot Demo Mode, which is
the real matching engine with demo funds. Payments are on the open x402 standard
rather than B402, because B402 merchant onboarding needs a business entity — the
code seam is built and flips on one env var." Two of those three sentences are
already true and already defensible. **The first one is not true yet, and making it
true is the highest-leverage 1.5 hours in this project.**

---

## Not checked

```text
[ ] The video — does not exist
[ ] Whether the GitHub repo is actually public (open it logged out)
[ ] The X steps and the Binance survey
[ ] Deployed behaviour — nothing is deployed; Vercel function timeout on the tick
    is unverified and the handoff itself flags it
[ ] Whether a Vercel function can OAuth to Binance MCP server-side (open question
    in handoff.md §9, and P1 above depends on it)
[ ] Latency and feel on camera
[ ] The field — whether other teams built a seller-side agent
```

## Claim gap

| Brief / handoff says | The code does | Severity |
|---|---|---|
| Binance MCP: "Essential — live prices, balances, placing the order" | zero MCP calls; REST + HMAC to `demo-api.binance.com` | SERIOUS |
| "an outside client — one we did not write" | `scripts/pay.mjs`, 37 lines, in this repo | MODERATE |
| "Omon earns money… both directions on screen" | no screen; `page.tsx` is the Next.js template | SERIOUS |
| "an agent that earns its own income and trades" | no loop; a human runs `npx tsx` | SERIOUS |
| manifest: `/api/signals` `"status":"planned"` | accurate — this one is right, keep doing this | — |
| manifest `disclosure`: testnet rail stated plainly | accurate | — |
