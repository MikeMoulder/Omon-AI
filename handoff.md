# Omon — handoff

*Written 2026-09-05. Read this top to bottom before touching anything.*

**Deadline: 2026-09-08 23:59 UTC.** Roughly 3.5 days of wall clock, about 20-24
hours of real build time for one person.

---

## 1. What this is

Omon is one system with two agents inside it, built for the **Binance Agent OS
Mini Hackathon**, submitted under **Track A — Payment Workflows**.

- **Intel Agent** — turns news headlines into structured market intelligence
  (`assets`, `direction`, `confidence`, `thesis`).
- **Signal Agent** — takes that intelligence plus live Binance prices, produces a
  trade signal, and places the order.

Both agents **sell their output to outside agents** over HTTP endpoints that
return a real `402 Payment Required`, settled in USDC. Between the Signal Agent
and Binance sits a **budget layer written in plain code** — the model proposes
trades, it never authorizes them.

**The one moment that wins or loses this:** at 0:25 in the demo video, a client
we did not write asks for the intel, gets a 402, pays, and receives the data —
while Omon's balance visibly moves on screen. Everyone at this hackathon built an
agent that spends money. Almost nobody built one that **gets paid**.

Longer form: `assets/idea-brief.md` and `assets/architecture-brief.md`.
Every technical finding, with evidence: `assets/spike-notes.md`.

---

## 2. State of play

**Every risky piece is proven. Nothing unknown is left.** What remains is wiring
code and a screen.

| Piece | Status | Evidence |
|---|---|---|
| Paid endpoint (x402) | working | tx `0x2c0b06de25ebed4c4fb32863779dd26c56d9c787d1478a66cfd21f84902a9859` on Base Sepolia, settled, 1.26s round trip |
| Binance MCP | connected | OAuth'd in Claude Code, live prices, UID 1273695308 |
| Intel + Signal agents | live | Gemini free tier, real structured output |
| Exchange prices | live | `demo-api.binance.com` |
| Spot order | **FILLED** | order `6947725227`, 0.008 BNB for 5.77 USDT |
| Futures order | FILLED | order `2635918071` — proven, then **cut from scope** |
| Budget layer | 16 tests green | `npx tsx scripts/budget-test.ts` |
| News -> intel -> cache | **working** | `npx tsx scripts/news-smoke.ts --live` |
| Paid endpoint serves live rows | **working** | tx `0xbe533fa76ce3f6b8fcf5b180e9d8a483cf0a3dafb5317bbea683fe65065d7266` |
| Discovery without a directory | **working** | `npx tsx scripts/discovery-smoke.ts` — 21 checks |
| Technical layer (EMA/ATR/breakout) | **working** | `npx tsx scripts/indicators-test.ts <ren-ai path>` — port matches the original on 19,980 bars |
| Signal = news + chart conviction | **working** | `npx tsx scripts/strategy-smoke.ts --live` |
| Cron tick (wiring + order half) | **NOT BUILT — next** | — |
| Console + SSE | NOT BUILT | — |
| Persistence | NOT BUILT | no database yet |
| README + video | NOT BUILT | — |

**Total cost so far: $0.** No real funds anywhere. That is deliberate and it is
not a compromise — see section 5.

---

## 3. Repo map

```
src/lib/types.ts       Shared shapes. Everything imports from here. Change with care.
src/lib/fixtures.ts    Recorded headlines + intel. The fallback every seam drops to.
src/lib/news.ts        RSS seam. fetchHeadlines() + newsMode() + feedErrors(). No key, no signup.
src/lib/intel-cache.ts News -> intel, held with a 5 min TTL. refreshIntel() writes, getIntel() reads.
src/lib/x402.ts        Payment rail. 402 challenge, verify, settle.
src/lib/llm.ts         Gemini. intelFromHeadline() + signalFromIntel() + llmMode(agent).
                       One key per agent: GEMINI_INTEL_API_KEY / GEMINI_SIGNAL_API_KEY,
                       both falling back to GEMINI_API_KEY.
src/lib/exchange.ts    Binance. getPrices/getBalances/placeOrder + exchangeMode().
src/lib/budget.ts      The leash. evaluateTrade() + spentToday(). No network, no model.
src/lib/indicators.ts  ema/atr/rsi/priorRange. Pure math, ported from ren-ai, byte-checked.
src/lib/strategy.ts    trendSignal + technicalSnapshot + conviction. The chart half.
src/lib/service.ts     What Omon sells, machine-readable. Feeds the manifest AND the 402
                       preview, so the two cannot drift.

src/app/api/intel/route.ts          The paid endpoint. Serves the cache. WORKS — do not casually refactor.
src/app/api/intel/refresh/route.ts  Free. GET = cache status, POST = collect news and analyse. The slow path.
src/app/api/manifest/route.ts       Free public catalogue. Aliased to /.well-known/x402 by next.config.ts.
src/app/page.tsx             Still the Next.js default page. This is the console's home.

scripts/pay.mjs              Outside buyer. Pays a 402 for real.
scripts/llm-smoke.ts         Exercises both agents.
scripts/exchange-smoke.ts    Prices, balances, and a real order.
scripts/budget-test.ts       16 assertions. Run after any budget change.
scripts/news-smoke.ts        Feeds -> intel -> cache. Asserts the TTL and the quota guard.
scripts/discovery-smoke.ts   Walks the path a stranger's agent walks. Needs a running server.
scripts/indicators-test.ts   Cross-checks the TS port against the original ren-ai JS.
scripts/strategy-smoke.ts    intel -> candles -> conviction -> signal -> budget, end to end.
```

**Seam discipline:** `src/lib/*.ts` are the only files that talk to the outside
world. Routes and components call seams; they never call an SDK or a URL
directly. Keep it that way — it is what makes the fixture fallback work.

**Every seam reports its own mode.** `llmMode()` and `exchangeMode()` return
`{mode, reason}`. The console should show these, so nobody is ever guessing
whether something is live.

**Next.js is version 16.3.4** and `AGENTS.md` warns it has breaking changes from
older training data. Read `node_modules/next/dist/docs/` before writing routes or
components. The library files above are plain TypeScript and are unaffected.

---

## 4. How to run things

```bash
npx tsx scripts/budget-test.ts                     # 16 tests, no credentials needed
npx tsx scripts/news-smoke.ts                      # feeds + cache, fixtures, offline
npx tsx scripts/news-smoke.ts --live               # real RSS + real Gemini
npx tsx scripts/news-smoke.ts --live --feeds       # feeds only, spends no quota
npx tsx scripts/strategy-smoke.ts --live          # candles -> conviction -> signal -> budget
npx tsx scripts/strategy-smoke.ts --live --chart-only   # technicals only, no model call
npx tsx scripts/indicators-test.ts ../ren-ai      # port vs original; skips if absent
npx tsx scripts/llm-smoke.ts --live                # real Gemini call
npx tsx scripts/exchange-smoke.ts --live           # prices + balances
npx tsx scripts/exchange-smoke.ts --live --order   # places a REAL demo order
npm run dev                                        # then in another shell:
curl -X POST 'localhost:3000/api/intel/refresh?force=1'   # fill the cache first
npx tsx scripts/discovery-smoke.ts                        # 21 checks, no payment
MSYS_NO_PATHCONV=1 node scripts/pay.mjs /api/intel        # outside agent pays the 402
```

**`--live` is required on the smoke scripts** because `.env.local` pins
`DEMO_MODE=fixture`. Without it they run fixtures and the banner says so.

Credentials in `.env.local` — all present and working: `GEMINI_API_KEY`
(plus empty `GEMINI_INTEL_API_KEY` / `GEMINI_SIGNAL_API_KEY` placeholders — fill
them from **separate Google Cloud projects** to actually split the quota),
`BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `BUYER_PRIVATE_KEY`, `PAY_TO_ADDRESS`.
`.env.example` documents every variable including ones not yet used.

---

## 5. Decisions already made — do not reopen these

Each of these cost time to settle. They are closed.

**Payments run on the public x402 rail (Base Sepolia), not Binance B402.**
B402 merchant onboarding requires an **Entity (business) Binance account**. An
individual cannot even press Apply. Verified in the portal. The b402 code seam
exists and flips with one env var if that ever changes.

**Orders run on Binance SPOT Demo Mode** (`demo-api.binance.com`), keys from
demo.binance.com. Not Spot Testnet. Demo Mode mirrors the live exchange — same
features, same exchange filters, realistic order books — while Testnet has an
independent order book and resets balances monthly. Demo Mode is also Binance's
own branded product, which reads better in a submission.

**No real funds are needed and none should be added.** Agent OS is an umbrella:
MCP + Skills + APIs + x402 + Agentic Wallet. Demo Mode and MCP reads are both
free. A competing entry (github.com/KattyFury/Binance-Agent) runs on Binance
Demo Trading, says so openly, and is a legitimate submission.

**`binance-cli` was evaluated and dropped.** It is official and it works, but it
ships no Windows binary, would need bundling into a Vercel deploy, and would mean
spawning a subprocess inside a serverless function. Plain REST hits the same
endpoints.

**Cut and staying cut:** the Treasury/yield agent (MCP has no Earn scope — the
rail does not exist), the reputation layer, "agent marketplace" framing, a human
approval flow, futures and margin, auth, onboarding, multi-user, Docker.

**Track B is dropped.** It needs real funded trades. Cost: 4 USDC. Track A's
prize pool is what matters.

---

## 6. Traps that already cost hours

**Setting `X402_RAIL=b402` without credentials makes `/api/intel` return 500.**
Verified 2026-09-05. Fail-fast is the right call for a paid route — silently
serving a rail nobody can pay would be worse — but on Vercel the only symptom is
a 500 in the demo. Check the env var before recording.

**The manifest must publish the request origin, not `RESOURCE_SERVER_URL`.** That
variable belongs to the buyer script; using it pinned every advertised URL to
`localhost:3000` regardless of what was actually serving. `PUBLIC_BASE_URL` is
the override, and it should normally stay empty.

**Binance runs three separate demo environments and they share nothing but the
key.** Spot Demo `demo-api.binance.com`, Futures Demo `demo-fapi.binance.com`,
Spot Testnet `testnet.binance.vision` (different keys entirely). A key from one
returns `-2015 Invalid API-key` on another. That error means wrong host far more
often than it means bad key.

**Gemini's REST response is not `output_text`.** That is an SDK convenience. The
raw body is `steps: [{type:"thought"}, {type:"model_output", content:[{text}]}]`.
`extractText()` in `llm.ts` handles it.

**Gemini model choice is a latency decision.** Measured on the same prompt:
`gemini-3.5-flash` took 14.7s and once failed outright at 39.6s;
`gemini-3.5-flash-lite` took 3.6s with zero thought tokens. Flash-Lite is the
default and also has the bigger free quota.

**Two Gemini keys do not mean two quotas.** Free-tier limits are enforced per
Google Cloud **project**, not per key. Two keys minted in the same project share
one allowance, so the intel/signal split only isolates anything if the keys come
from separate projects. `keysAreSplit()` reports whether two distinct keys are
set — it cannot see the project, so verify that part by hand.

**The model's symbol list and the budget allowlist must be the same list.** The
Signal Agent picks from whatever was passed to `getPrices`; `evaluateTrade`
approves from `BUDGET_ALLOWED_SYMBOLS`. If they drift, the model proposes a
legal-looking pair and every trade is blocked — which reads as a broken model,
not a config mismatch. Feed `limitsFromEnv().allowedSymbols` into `getPrices`,
as `scripts/strategy-smoke.ts` does.

**Market-data reads are always live, even when `DEMO_MODE=fixture`.**
`exchangeMode()` governs *writes* (orders). Prices and candles are public
endpoints needing no key, so they stay real — which means fixture mode is not
fully offline. `getCandles` degrades to `[]` on failure rather than throwing, and
the Signal Agent treats that as "decide on the news alone".

**Gemini free quota is roughly 1,000 requests/day.** The tick makes 2 calls.
**Never cron it every minute** — that is 2,880 calls/day and the account locks
out, most likely on the day you record. Every 15 minutes, or manual trigger.

**A backslash inside a JS template literal is not a backslash.** `` new RegExp(`([\s\S]*?)`) `` collapses
to the character class `[sS]`, which matches nothing useful. This turned every RSS
feed into an empty parse while the mode banner still said LIVE, and the only
visible symptom was `example.com` fixture URLs in otherwise perfect output. Use
`String.raw` for any regex built from a template literal.

**A silent fixture fallback is worse than a crash.** The seam did exactly what it
was designed to do and hid a real bug for an hour. Every seam that can fall back
now records *why* — `feedErrors()` in news.ts — and the smoke test fails in live
mode if it is served fixtures. Do the same for any new seam.

**Keyed news APIs are a trap for this project.** cryptocompare returns 401 on the
free tier as of 2026-09-05 and the Binance announcement page blocks scripted
fetches. Plain RSS needs no key, no signup and no quota, so nothing can lock us
out on recording day. Cointelegraph, CoinDesk and Decrypt all verified 200.
CoinDesk redirects once, so `redirect: "follow"` is required.

**Binance rejects the `symbols` array if there is a space after the comma.**
Standard serializers add one. `getPrices()` builds the string by hand.

**Futures market orders return `status: NEW, executedQty: 0` on a successful
fill.** Query the order or position afterward to see the truth. Spot with
`newOrderRespType: RESULT` returns `FILLED` immediately — which is why the spot
path is safe as written.

**Do not trust remembered market prices.** An earlier version of the notes
claimed testnet had drifted from mainnet, based on a placeholder number that was
never measured. BTC is near 79.6k and all four sources agree within a cent.
Measure, then write it down.

---

## 6b. Where the trading edge comes from

The Signal Agent is no longer a model guessing from a headline. It now has a
technical half, ported from **github.com/MikeMoulder/ren-ai** — the user's own
Bitget-hackathon trading agent — and the port is verified bar-for-bar against the
original JavaScript (`scripts/indicators-test.ts`, 19,980 bars, 0 mismatches).

**What that agent's paper log actually shows** (42 closed trades, `trades.csv`):

| | |
|---|---|
| Win rate | 47.6% |
| Avg win / avg loss | +$228 / -$176, payoff 1.29 |
| Expectancy | **+$16.03 per trade** |
| Total | +$673 on $50k (+1.35%), max drawdown -3.21% |

**The finding this design is built on:** the log scores every entry for
"confluence" — sentiment agreeing with the technical signal. Split by it:

| | n | win rate | total |
|---|---|---|---|
| Sentiment **aligned** with direction | 26 | 54% | **+$1,444** |
| Sentiment **neutral** | 11 | 36% | **-$1,181** |

Every dollar of profit came from aligned trades. **Say the sample size out loud
if this goes in the video** — n=11 in the neutral bucket is a design lead, not a
proven law. Overclaiming it is the kind of thing a judge catches.

Omon's intel already emits `direction` + `confidence`, which *is* a confluence
score. `conviction()` in `src/lib/strategy.ts` blends it with the chart and
flags `aligned`. Observed working: bearish news against an up chart scored 0.12
(low), and the model sized the trade at the $5 floor with a thesis citing
"+1.3% above its EMA200".

**Two deliberate departures from the original, both load-bearing:**

1. **The breakout is advisory, not a gate.** A 10-bar breakout on 1h candles
   fires perhaps once a week per symbol. Gating on it means a demo that shows
   nothing. The chart is scored and handed to the model instead.
2. **No shorts, no trailing stops.** Spot cannot short without holding the asset,
   and a trailing stop needs a position monitor plus durable storage. The ren-ai
   log agrees anyway: its shorts lost $284, its longs made $957.

Interval is `CANDLE_INTERVAL`, default `1h` rather than the 4h the log was
measured on — same rules, a clock a 2:15 demo can actually reach.

## 7. What to build next, in order

**1. The tick — `POST /api/cron/tick`.** The spine, and its **first half now
exists**: `POST /api/intel/refresh` already does RSS → `intelFromHeadline` → cache,
end to end, live. What is left is the trade half — take the newest cached intel →
`getPrices` → `signalFromIntel` → `evaluateTrade` → `placeOrder` if ALLOW. Either
extend the refresh route or add `/api/cron/tick` that calls `refreshIntel()` first.
**Never run this inside a user-facing request** — two LLM calls plus an order is
15-40s. Call it on a **5 minute** interval to match the cache TTL; the quota guard
(`INTEL_MAX_NEW=3`) is what keeps that inside the Gemini free tier.

**2. Persistence.** There is no database yet. Intel currently lives in the
in-process cache in `src/lib/intel-cache.ts`, which is lost on a cold start —
that file is the single place to change when a store lands. Four tables in the architecture
brief: `intel`, `signals`, `purchases`, `actions`. The budget ledger is *derived*
from `actions` + `purchases` — `spentToday()` already does this. Do not add a
balance column. Postgres/Neon + Drizzle was the plan; anything durable works, and
if time is short, a single JSON file beats missing the deadline.

**3. The console — `src/app/page.tsx` + `/api/stream`.** One screen. Intel feed
on the left; money in (payments) and money out (orders) on the right, balance
large and animated. **The moment a payment lands must be impossible to miss** —
that is the aha. Show `llmMode()` and `exchangeMode()` somewhere honest.

**4. `/api/signals`** as a second paid endpoint. Copy `/api/intel`.

**5. The BLOCKED beat.** Trigger a trade above `BUDGET_MAX_TRADE_USD` ($25) and
show the refusal with its reason. The layer already does this and is tested.

**6. Deploy to Vercel.** Should have happened on day one. Do it before polishing.
Verify the tick does not exceed the function timeout in production.

**7. README and the 2:15 video.** See section 8.

**Feature freeze at T-2h.** Record a clean fallback take early.

---

## 8. Submission requirements

- Follow `@binance` on X, repost the announcement, then **reply or quote-repost
  with the submission** — demo video plus GitHub link.
- Complete the official survey while logged into Binance.
- **This is not a git repository yet.** `git init`, commit, push to GitHub. Do
  this well before the deadline, not at the end.
- `README.md` is still the Next.js default. It needs rewriting.

**Put this table near the top of the README and say it out loud in the video:**

| Layer | Where it runs | Real? |
|---|---|---|
| Market data, balances | Binance Agent OS MCP | Live mainnet |
| Order execution | Binance Spot Demo Mode | Real engine, demo funds |
| Agent-to-agent payments | x402, Base Sepolia | Real protocol, test USDC |

Both money rails are non-production. A judge will see that in ten seconds.
Stating it first makes it a non-issue; hiding it is the only fatal move.

**Do not claim** the trade was placed through Binance MCP. It was placed through
the Binance REST API on Demo Mode. MCP provides market data and account state.
Both are true and both are Agent OS — keep them straight.

---

## 9. Open questions

**Can Claude Desktop actually pay a 402?** This is the biggest remaining risk,
because the aha moment depends on it. Claude Desktop has no built-in wallet — it
needs a payment-capable MCP server wired in. **Verify this before building the
demo around it.** If it cannot, the buyer is `scripts/pay.mjs`, which is still an
outside client and not run in-process, and the wording changes from "Claude
Desktop pays" to "an external agent pays". Do not describe it as Claude Desktop
until it is proven.

**Can a Vercel app authenticate to Binance MCP server-side?** The MCP connection
here was OAuth'd through Claude Code. Whether a deployed Next.js app can do the
same is unverified. If yes, the console's prices flow through MCP. If no, MCP
appears in the demo via Claude Code or Claude Desktop and the app uses REST.
Either is honest; it only changes the wording.

**An open 0.01 BNB futures long** is sitting on the demo account from a test.
Harmless. Close with a reduceOnly SELL if it bothers anyone.

---

## 10. How the user wants to be talked to

From `CLAUDE.md`, in their words: *"I do not like how you can't speak in
understandable terms... give me straightforward responses."*

Plain words. Short sentences. Lead with the answer, not the setup. Every
recommendation gets a reason in normal English. No jargon unless it is defined in
the same sentence. No filler, no preamble, no recap.

They are sharp and they check things — they caught a fabricated price claim and
found Spot Demo Mode when the docs had been read wrong. **Verify before
asserting, and say plainly when something turns out to be wrong.**
