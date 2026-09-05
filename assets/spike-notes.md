# Spike notes — 2026-09-04 night

What was verified by running it, not by reading about it.

## Spike 2 — paid endpoint (x402 seller) — DONE, SETTLED ON CHAIN

`GET /api/intel` returns a real HTTP 402. An outside client — a script the server
knows nothing about — reads the challenge, signs it, retries, and gets the data.
Money actually moved:

```
[buyer] GET http://localhost:3010/api/intel
status: 200   paymentStatus: 'settled'
payer:       0xeE5d0ee0B22b017aE005392FEEa3A9cF5D486651
transaction: 0x2c0b06de25ebed4c4fb32863779dd26c56d9c787d1478a66cfd21f84902a9859
network:     eip155:84532        // Base Sepolia
amount:      10000 (0.01 USDC)
```

Round trip: 1.26s. This is the aha moment, working, on 2026-09-04.

Stack that works: `@x402/next` `withX402(handler, routes, server)` +
`@x402/core/server` `HTTPFacilitatorClient` + `@x402/evm/exact/server` `ExactEvmScheme`.
Buyer: `@x402/fetch` `wrapFetchWithPayment` + `@x402/evm/exact/client`.

### Gotcha that cost 20 minutes
Next expands `$VAR` inside `.env` files, so `X402_PRICE=$0.01` became `.01` and
`parsePrice` threw a 500. Price is now stored without the `$` and the code adds it.

## The Binance rail is CLOSED to us — confirmed 2026-09-04

`@bnb-chain/b402` (the official Binance OnchainPay provider) needs merchant
credentials that Binance issues during onboarding:

```
B402_BASE_URL, B402_CLIENT_ID, B402_ACCESS_TOKEN, B402_PRIVATE_KEY
```

`B402_PRIVATE_KEY` is an **RSA request-signing key issued at onboarding**, not an
EVM key. The example `.env` in `bnb-chain/mpp-sdk` points at a QA host
(`https://qacb.sdtaop.com`), which means the public base URL comes with the
credentials too.

So the seller side of *Binance* x402 is gated on a Binance Pay merchant account.

**The merchant application requires an Entity (business) Binance account.** An
individual account cannot even press Apply — the portal says "switch to an Entity
Account" and lists "Entity Binance Account" and "Company Website / Store
Information" as required. Verified in the portal, not guessed.

That closes the B402 seller rail for this hackathon. It is an account problem, not
a code problem, and it cannot be solved in four days.

**Decision: ship on the public x402 rail.** Say so out loud in the README and the
video. Binance stays load-bearing through MCP — live prices and the real order —
which an individual account *can* use.

**Mitigation already built in:** `src/lib/x402.ts` is a seam with one switch.
`X402_RAIL=testnet` runs the public x402 facilitator on Base Sepolia today.
`X402_RAIL=b402` swaps in Binance's rail the moment credentials land. No route
changes either way.

### Version mismatch, noted
`@bnb-chain/b402@0.2.1` declares a peer of `@x402/core ^2.19`; installed core is
`2.25`, which widened `SchemeNetworkServer` (`defaultAssetTransferMethod`,
`paymentFlows`). The b402 scheme is cast at the seam. If the b402 rail is used
for real, pin `@x402/core` to `2.19.x` instead of trusting the cast.

## Spike 1 — Binance MCP — BLOCKED ON A HUMAN

Endpoint is `https://agent.binance.com/mcp/agentic`. Authentication happens in a
logged-in Binance account (Agentic sub-account + permissions), so it cannot be
done from here. `developers.binance.com` is behind an AWS WAF JavaScript
challenge, so the docs cannot be read by tooling either — open them in a browser.

Docs: https://developers.binance.com/en/docs/agent-native/mcp-server

## Open questions to close next

- ~~Can a personal account get B402 merchant credentials?~~ **No. Entity account
  required. Closed.**
- Does Binance MCP have a paper/testnet mode, or does the demo need a funded
  sub-account?
- Bazaar indexing needs a confirmed settle carrying merchant metadata — which
  means it needs the B402 rail. On the testnet rail, hand the URL over directly.

## Spike 1 — Binance MCP — CONNECTED AND AUTHENTICATED (2026-09-04)

Server registered in `.mcp.json` at `https://agent.binance.com/mcp/agentic`. OAuth
completed. ~90 tools exposed: spot, margin, convert, USD-M futures, COIN-M futures,
wallet, sub-account.

**Key permissions on the agentic sub-account — UID 1273695308:**

```
enableReading:              true
enableSpotAndMarginTrading: true
enableFutures:              true
enableWithdrawals:          FALSE   <-- the safety answer, and it is verifiable
enableInternalTransfer:     false
ipRestrict:                 false
```

`enableWithdrawals: false` is the single best line in the Q&A. The agent cannot move
money off the exchange. That is enforced by Binance, not by our code. Say it out loud.

**Reads confirmed working:**

```
spot_tickerPrice   BNBUSDT -> 718.75
spot_exchangeInfo  BNBUSDT -> NOTIONAL minNotional 5.00 (applies to MARKET orders)
                              LOT_SIZE stepSize 0.001 BNB
spot_getAccount    balances: []          <-- EMPTY
```

**Blocked on funding.** The sub-account has zero balance, so no order can be placed.
Transfer from the main account here:
https://www.binance.com/en/my/sub-account/asset-management/transfer

~$20 USDT is enough: the exchange minimum is $5 per order, and withdrawals are
disabled, so $20 is the hard ceiling on total loss.

**Gotcha:** `spot_tickerPrice` rejects the `symbols` array if the serialized JSON has a
space after the comma. Use one `symbol` per call, or build the array string manually.

**Track B note:** spot, futures and margin/convert are all permitted on this key, so
the three Track B tasks run through this same connection once funded.

## No demo mode on Binance MCP — settled 2026-09-05

Read the whole official page, all 562 lines:
`developers.binance.com/en/docs/agent-native/mcp-server/agentic.md`

```
grep -ni "testnet|demo|sandbox|paper|simulat|virtual fund|mainnet" -> 0 matches
```

The only line about funds says: *"this is the step that spends real funds."*
There is no env var, no toggle, no sandbox URL. The Agentic sub-account is a real
sub-account of the real Binance account, holding real assets.

**Binance Spot Testnet is not a substitute.** It exists at `testnet.binance.vision`
with free virtual funds, but it is a different system entirely: separate signup,
separate API key, REST/WS only, no MCP, no Agent OS, no Agentic sub-account. Orders
placed there are NOT "placed through Agent OS" and would not back that claim in the
submission. It also does not count for Track B.

**Decision: real funds, small.** ~$20 into the Agentic sub-account.
- Exchange minimum per order is $5 notional.
- `enableWithdrawals: false` on the key, so $20 is the hard ceiling on total loss.
- A $6 market buy of BNB does not cost $6 — you still hold the BNB. Real cost is the
  0.1% fee plus spread, a few cents.

Testnet still has a job: it is the free target for `DEMO_MODE=testnet` while building
the seam, so development never touches real funds. Only the recorded demo runs live.

## Second finding on the same page — confirm-before-execute

> "This confirm-before-execute pattern applies to every non-read action — orders,
> cancels, and transfers between your sub-account wallets."

In a chat client that is the human pressing yes. **Unverified for a server-side MCP
client**, which is what Omon is. If Binance enforces it server-side, a fully
autonomous trade is impossible and the tick has to surface an approval step.

TEST THIS BEFORE BUILDING THE TICK. It is now the biggest unknown in the project —
bigger than the payment rail, which is already working.

## Zero-budget plan — decided 2026-09-05

No funds available. Locking the build to a $0 path.

**What stays real and live through Agent OS:**
Reads cost nothing and already work on an empty sub-account — verified:
`spot_tickerPrice BNBUSDT -> 718.75` with `balances: []`. So live prices, klines,
24h stats, account state and permissions all run through the official Binance MCP
server for real. The Agent OS integration is genuine on the data path.

**What moves to testnet:**
Order execution -> Binance Spot Testnet (`testnet.binance.vision`). Free API key,
GitHub login, no Binance account needed, real matching engine, real order ids.
Confirmed from the official testnet docs:
> "Step 1: Log in on this website, and generate an API Key.
>  Step 2: ... replacing the URLs of the endpoints with `https://testnet.binance.vision/api`"

CHECK ON SIGNUP: whether test balances are granted automatically or need a faucet
click. Two minutes to find out. Everything below assumes they arrive.

**The claim changes. Say it exactly like this:**
- YES: "Live market data and account state through Binance Agent OS MCP."
- YES: "Orders execute on Binance Spot Testnet with real order ids."
- NO:  "The trade was placed through Agent OS." That is now false. Do not say it.

**Track B is dropped.** It needs real spot + futures + margin/convert trades in a
funded Agentic sub-account. Not possible at $0. Cost: 4 USDC. Track A is the prize
that matters (2000 / 1500 / 1000 / 50x300).

**Disclosure table for the README — write it, do not bury it:**

| Layer | Where it runs | Real? |
|---|---|---|
| Market data, balances, permissions | Binance Agent OS MCP | Live mainnet |
| Order execution | Binance Spot Testnet | Real engine, test funds |
| Agent-to-agent payments | x402, Base Sepolia | Real protocol, test USDC |

Both money rails are testnet. Judges will see that instantly — so put the table near
the top of the README and say it in the video. Hiding it is the only fatal move.

**$6 upgrade path, if funds ever appear before recording:**
One $6 market buy of BNB through MCP restores "placed through Agent OS" as a true
claim. It is not $6 spent — the BNB is still yours; real cost is the 0.1% fee, about
one cent. Keep the seam switchable so this is an env var, not a rewrite.

## CORRECTION 2026-09-05 — Agent OS DOES have a demo path

Earlier note said real funds were required for any order through Agent OS. That was
right about the **MCP server** and wrong about **Agent OS as a whole**.

`binance-cli` — official, `github.com/binance/binance-cli`, published through the
Agent OS Skill Hub — supports three environments:

```
BINANCE_API_ENV = prod (default) | demo | testnet
BINANCE_SPOT_BASE_PATH         e.g. https://testnet.binance.vision
BINANCE_FUTURES_USDS_BASE_PATH e.g. https://testnet.binancefuture.com
BINANCE_API_KEY / BINANCE_SECRET_KEY
```

Install (official):
```
curl --proto '=https' --tlsv1.2 -LsSf   https://github.com/binance/binance-cli/releases/latest/download/binance-cli-installer.sh | sh
```

**Confirmed in the wild.** A competing entry (github.com/KattyFury/Binance-Agent,
x.com/nguyen0xhieu/status/2095725596085289175) runs on Binance Demo Trading, states
it openly in the submission, and calls itself an Agent OS entry. Their README even
sells the choice: *"binance-cli — Binance Agent OS Skill Hub CLI, not a hand-rolled
REST client."* So demo funds are acceptable to the judges. Settled.

**Windows problem.** Release v2.1.1 ships darwin + linux-gnu only. No Windows binary.
This machine has WSL Ubuntu 24.04 (stopped) — that is where the CLI goes. Vercel runs
linux-x86_64, so the same binary works in production.

**Revised split — all of it free:**

| Layer | How | Cost |
|---|---|---|
| Market data, balances, permissions | Binance MCP (already connected) | $0 |
| Order execution | `binance-cli`, `BINANCE_API_ENV=demo` | $0 |
| Agent-to-agent payments | x402, Base Sepolia | $0 |

**The claim is true again:** "Executes through official Binance Agent OS tooling on
demo funds." Do not drop the words "demo funds" — the competitor didn't, and it cost
them nothing.

**Track B: still assume dropped.** Payout eligibility is checked against real trades
in a funded Agentic sub-account. Demo trades almost certainly do not count. 4 USDC.

**Competitor bar, for calibration.** Their loop: scanner finds a signal on price +
open interest each minute, Claude confirms or rejects it, then an order goes out at
1% risk. Fails closed if Claude is down. Competent and ordinary — a solo trading bot.
Nothing in it sells to other agents. Omon's paid-endpoint angle is still the
differentiator.

## binance-cli DROPPED 2026-09-05 — plain REST is also Agent OS

The Agent OS landing page tags every capability card with the surfaces that provide
it, and **"APIs" appears on four of the six cards** — Trade, Pay & Settle, Read the
Market, Track Your Portfolio. Agent OS is the umbrella: MCP Server + Skills + APIs +
Binance Pay/x402 + Agentic Wallet + Web3 APIs + AI Pro.

So Binance Exchange REST/WS **is** an Agent OS surface. Using it does not weaken
eligibility, and it removes three problems at once:

- no WSL dependency (the CLI ships no Windows binary)
- no Linux binary bundled into a Vercel deploy
- no subprocess spawn inside a serverless function with a 10s ceiling

`src/lib/exchange.ts` calls `https://testnet.binance.vision/api` directly. Same
endpoints the CLI wraps, one less moving part.

**The caveat, stated honestly:** "we called the REST API" is the *weakest* form of an
Agent OS claim. Every Binance bot written in the last eight years called that API —
it predates Agent OS entirely. It clears the eligibility bar and scores near zero on
integration depth. That is precisely why the competing entry's README brags
*"binance-cli — Agent OS Skill Hub CLI, not a hand-rolled REST client."*

**So depth has to come from the two surfaces that are not ordinary:**

| Surface | Ordinary? | Omon uses it for |
|---|---|---|
| Binance MCP | New, Agent-OS-only | Live prices, balances, portfolio state |
| x402 | New, Agent-OS-only | Agents paying Omon per call |
| Exchange REST | Eight years old | Order execution on testnet |

Lead the README and the video with MCP and x402. Mention REST once, as plumbing.

**OPEN QUESTION — decides where MCP appears.** The MCP connection in this session was
OAuth'd through Claude Code. Whether a Next.js app on Vercel can authenticate to
`agent.binance.com/mcp/agentic` server-side is UNVERIFIED.

- If yes: market data in the app runs through MCP. Strongest version.
- If no: MCP appears only as Claude Desktop buying intel on camera, and the app uses
  REST for data too. Still true, weaker.

Test this before hour 8. It decides how the whole thing is described.

## LLM seam — LIVE on Gemini free tier, 2026-09-05

`src/lib/llm.ts`. Both agents produce real, correctly-shaped output:

```
[llm-smoke] mode: LIVE  (gemini gemini-3.5-flash-lite)
intel   -> {assets:[USDT,USDC,BTC], direction:bullish, confidence:0.65, summary:...}
signal  -> {symbol:BTCUSDT, side:BUY, sizeUsd:32.5, thesis:...}
ok in 13.31s
```

Run it with `npx tsx scripts/llm-smoke.ts --live` (`--live` is needed because
`.env.local` pins `DEMO_MODE=fixture`).

**Three things the docs do not tell you, all found the hard way:**

1. **The REST response is not `output_text`.** That is an SDK convenience. The
   raw body is `steps: [{type:"thought"}, {type:"model_output", content:[{text}]}]`.
   Read backwards for the last `model_output`. `extractText()` handles both.
2. **Model choice is a latency decision, not a taste one.** Measured on this
   account with an identical trivial prompt:
   | model | time | thought tokens |
   |---|---|---|
   | `gemini-3.5-flash` | 14.7s (and one outright failure at 39.6s) | 120 |
   | `gemini-3.5-flash-lite` | **3.6s** | 0 |
   Flash-Lite is now the default. It also has the larger free daily quota.
3. **Timeout floor is ~30s, not 12s.** These models think before answering even
   on trivial input. 12s times out on a cold call.

**Quota is the real constraint.** Free tier is Flash-only: roughly 250 req/day on
flash, 1,000/day on flash-lite. The tick makes 2 calls. **Do not cron the tick
every minute** — 1,440 ticks/day is 2,880 calls and the account locks out, most
likely on recording day. Every 15 minutes, or manual trigger during the demo.

`GEMINI_API_KEY` empty or `DEMO_MODE=fixture` falls back to fixtures silently, so
a dead model never breaks the demo. `llmMode()` reports which path is live and why.

## Exchange seam built — 2026-09-05

`src/lib/exchange.ts`. Binance Spot Testnet, HMAC-SHA256 signed REST.
`getPrices` / `getBalances` / `placeOrder`, plus `exchangeMode()` matching
`llmMode()` so the console can show one honest status line per seam.

Public price read works with **no key at all** — verified:

```
npx tsx scripts/exchange-smoke.ts
prices -> { BNBUSDT: "721.38", BTCUSDT: "79660.77" }
```

**Orders are sized in USD, not coins.** `quoteOrderQty` on a MARKET order means
Binance computes the quantity, so LOT_SIZE stepSize rounding never comes up.
`MIN_NOTIONAL_USD = 5` is enforced before the call with a readable error.

**CORRECTION 2026-09-05.** An earlier version of this file claimed testnet
prices had drifted from mainnet, with BTCUSDT at "79,660 testnet vs ~104,200
mainnet". **That mainnet figure was never measured** — it was a placeholder
number typed into `scripts/llm-smoke.ts` as fake input, then written up here as
if it were a reading. It was wrong.

Actually measured, same minute, four sources:

| source | BTCUSDT |
|---|---|
| testnet spot (`testnet.binance.vision`) | 79641.03 |
| mainnet spot (`api.binance.com`) | 79641.02 |
| Binance MCP (real sub-account) | 79641.03 |
| futures demo (`testnet.binancefuture.com`) | 79604.50 |

**Testnet spot tracks mainnet.** MCP is accurate. BTC is simply near 79.6k
today. There is no price-environment decision to make and nothing to disclose in
the README about it. `BINANCE_PRICE_BASE_PATH` stays as an escape hatch in case
a host is ever blocked in production — `https://data-api.binance.vision` is the
public mainnet alternative — but the default needs no justification beyond being
the same host the orders go to.

**Carried the MCP lesson across:** the `symbols` array is built as a raw string,
not via a serializer — Binance rejects it if there is a space after the comma.

**Blocked on nothing but a key.** Free, GitHub login, no Binance account, free
test funds: https://testnet.binance.vision -> `BINANCE_API_KEY` +
`BINANCE_SECRET_KEY` in `.env.local` -> `npx tsx scripts/exchange-smoke.ts
--live --order` prints a real order id.

## Budget layer done — 2026-09-05

`src/lib/budget.ts` + `scripts/budget-test.ts`. **16 tests, all passing**, no
network, no keys, no model. Runs in milliseconds.

`evaluateTrade()` returns ALLOW / BLOCK / REQUIRE_APPROVAL with a human reason
and the remaining daily budget. Checks run most-absolute first so the reason is
always the most fundamental thing wrong:

1. size is not a positive finite number
2. symbol not on the allowlist
3. below the $5 exchange minimum
4. over the per-trade cap
5. would breach the daily cap
6. above the auto-approve threshold -> REQUIRE_APPROVAL

**Model output is treated as hostile input.** NaN, Infinity, -Infinity, negative
and zero sizes are all covered by tests, because a hallucinated `sizeUsd` is the
realistic failure mode and a naive `>` comparison lets NaN through silently.

`spentToday()` derives the ledger from the action log — only trades that were
ALLOWed *and* produced an order id count. No second counter that can drift from
what actually happened. Tested against blocked trades, allowed-but-failed
trades, payouts, entries older than 24h, and malformed payloads.

**Defaults are deliberately small:** $25 per trade, $100/day,
BNBUSDT/BTCUSDT/ETHUSDT only. The demo's BLOCKED beat is just a trade above $25,
so keep `BUDGET_MAX_TRADE_USD` low or the beat stops working.

**What to say on camera:** the model proposed it, the code refused, and the
model has no way to raise the limit. That is the whole point of the beat.

## Key diagnosis 2026-09-05 — futures demo key, spot testnet endpoint

The supplied key fails on spot and works on futures. Same key, same minute:

```
SPOT testnet   (testnet.binance.vision)    HTTP 401  -2015 Invalid API-key...
FUTURES demo   (testnet.binancefuture.com) HTTP 200  [{asset:"FDUSD", balance:"0.00000000", ...}]
```

Key and secret are both 64 chars with no whitespace, so the format is fine — it
is simply a key for a different system. **Binance runs several separate demo
environments and none of them share credentials:**

| environment | host | key issued at |
|---|---|---|
| Spot Testnet | `testnet.binance.vision` | testnet.binance.vision (GitHub login) |
| Futures Demo | `testnet.binancefuture.com` | demo.binance.com / testnet.binancefuture.com |
| Agentic sub-account | `api.binance.com` via MCP | OAuth, real account, real funds |

`src/lib/exchange.ts` targets Spot Testnet, so it needs a spot key.

**Also: the futures demo balance is 0.00 FDUSD.** Test funds have to be claimed
in that UI regardless of which environment is chosen.

**Decision — get a spot key, do not switch to futures.** The futures API is a
different surface (`/fapi/*`, `quantity` not `quoteOrderQty`, leverage and
margin type set as separate calls first), and futures was already on the cut
list. Signals are spot-shaped. Switching costs hours and buys nothing a judge
can see.

## SPIKE 1 COMPLETE — real spot order on Binance Demo Mode, 2026-09-05

```
[exchange-smoke] mode: LIVE  (binance spot @ demo-api.binance.com)
balances -> { USDT: "5000.00", USDC: "5000.00" }
order    -> orderId 6947725227  BNBUSDT BUY  FILLED
            executedQty 0.008 BNB   spent 5.77144 USDT
```

**ORDER ID 6947725227.** That is the number for the video.

**The environment I had missed: SPOT Demo Mode.** There are three, not two, and
Demo Mode is the right one:

| environment | REST host | keys from | order book |
|---|---|---|---|
| **Spot Demo Mode** | `demo-api.binance.com` | demo.binance.com API management | **mirrors live exchange** |
| Spot Testnet | `testnet.binance.vision` | testnet.binance.vision (GitHub) | independent, resets monthly |
| Futures Demo | `testnet.binancefuture.com` | demo.binance.com | futures only |

Per Binance's own comparison: Demo Mode "always has the same features as the
live exchange", its "prices and order books are similar to the live exchange",
and its exchange filters are *exactly* the same. Testnet is the odd one out —
independent prices, monthly balance resets, and sometimes unreleased features.

Two consequences:
1. `BINANCE_SPOT_BASE_PATH` now defaults to `https://demo-api.binance.com`.
2. **One key covers spot and futures demo** — both are issued from the same
   demo.binance.com account. The earlier -2015 was only ever a wrong-host error.

**Funds arrive already claimed:** 5,000 USDT and 5,000 USDC, no faucet step.

**What this does to the pitch.** "Demo Mode" is Binance's own branded product
with live-equivalent behaviour, which reads far better than "testnet" and is
exactly what the competing entry says it uses. The submission line is now:

> Orders execute on Binance Spot Demo Mode — the same API, the same exchange
> filters and live-equivalent order books, with no real funds at risk.

## Futures Demo also works — same key, 2026-09-05

```
POST /fapi/v1/leverage   BNBUSDT 5x
POST /fapi/v1/order      BNBUSDT BUY MARKET qty 0.01
  -> orderId 2635918071
position -> 0.01 BNB long, entry 721.52, notional $7.21, cross margin, 5x
```

**One key, three hosts, one account** (`accountAlias TiuXsRsRXqAuSg`):
`demo-api.binance.com` (spot), `demo-fapi.binance.com` and
`testnet.binancefuture.com` (futures — both answer, same balances).
Funded on arrival: 5,000 USDT, 5,000 USDC, 0.02 BTC.

**Futures is a different API shape from spot** — worth knowing, still not worth
adopting:
- `quantity` in base asset, not `quoteOrderQty`. Needs LOT_SIZE stepSize
  (BNBUSDT perp: step 0.01, minQty 0.01, minNotional 5).
- Leverage is a separate POST before the order.
- A market order returns `status: NEW` with `executedQty: 0`. It has still
  filled — read `/fapi/v2/positionRisk` to see it. Trusting the order response
  alone would make it look rejected.

**Futures stays cut.** Omon's signals are spot-shaped and the extra surface buys
nothing a judge sees. This run exists to prove the account can do it — and it
leaves an open 0.01 BNB long that can be closed with a reduceOnly SELL whenever.
