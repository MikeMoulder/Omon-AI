# Omon

**An AI agent that sells market intelligence to other agents, and trades on what it knows.**

Everyone at this hackathon built an agent that spends money. Omon is one that
**gets paid**: its endpoints answer with a real HTTP `402 Payment Required`, and
an outside agent with nothing but the URL can discover the service, pay in USDC,
and get the data — no account, no API key, no signup form.

Built for the **Binance Agent OS Mini Hackathon**, Track A — Payment Workflows.

---

## What is real, and what is not

Stated first, because both money rails here are non-production and a judge will
see that in ten seconds.

| Layer | Where it runs | Real? |
|---|---|---|
| Market data — prices, candles, account state | **Binance MCP** (`agent.binance.com`) | Live mainnet, real account |
| Order execution | **Binance Spot Demo Mode** (`demo-api.binance.com`) | Real matching engine, demo funds |
| Agent-to-agent payments | x402, Base Sepolia | Real protocol, test USDC |

Payments settle on the **open x402 standard rather than Binance's B402**, because
B402 merchant onboarding requires an Entity (business) Binance account that an
individual cannot apply for.

The B402 mapping itself is finished and checkable. `X402_RAIL=b402-preview`
publishes it — same code path the live rail uses — while payments keep settling
on the public facilitator, so nothing on screen claims B402 is taking money when
it is not:

```bash
X402_RAIL=b402-preview npm run dev
curl localhost:3000/api/b402 | jq .          # the exact BSC challenge, and what is still missing
npx tsx scripts/b402-test.ts                 # 25 assertions, no credentials, no network
```

`wouldAdvertise` in that response is built by `b402Accepts()`, the same function
the live rail calls, and the test suite runs the provider's own
`B402ExactServerScheme.parsePrice` against it. What is genuinely blocked is one
handshake: `signerAddress`/`spenderAddress` come from the facilitator's
RSA-gated per-merchant `/supported`, so they are left unset rather than guessed.
Flipping to `X402_RAIL=b402` with credentials changes nothing else.

---

## Binance Agent OS integration

Two Agent OS surfaces carry this project, and the split between them is
deliberate rather than partial.

| Agent OS surface | Used for | Where |
|---|---|---|
| **Binance MCP Server** | Every market read: `spot_tickerPrice`, `spot_klines`, `spot_getAccount` | [`src/lib/mcp.ts`](src/lib/mcp.ts) |
| **Binance Exchange API** (Spot Demo Mode) | Order execution only | [`src/lib/exchange.ts`](src/lib/exchange.ts) |

**Reads go through MCP. Writes do not.** The MCP token authorises the operator's
real Binance account (`canTrade: true`), so an order placed over MCP would spend
real money. Demo Mode is a separate host with separate keys and no real funds.

The MCP call that matters is **`spot_klines`**, not the price label: those
candles are what the ported technical engine in [`src/lib/indicators.ts`](src/lib/indicators.ts)
and [`src/lib/strategy.ts`](src/lib/strategy.ts) computes EMA, ATR, RSI and
breakout structure on. Agent OS data drives the analysis, not just a number on a
screen.

**Check the claim rather than taking it:**

```bash
npx tsx scripts/mcp-smoke.ts     # opens a real MCP session, asserts no REST fallback
curl localhost:3000/api/agent-os # live connection state, tools resolved, token health
curl localhost:3000/.well-known/x402 | jq .agentOs
curl localhost:3000/api/b402      # B402 rail: what is mapped, what is missing, what it would issue
```

`mcp-smoke.ts` deliberately fails if the data arrived over the REST fallback
instead of MCP. An integration that silently degrades is one that quietly stops
existing.

### Connecting to Binance MCP

Binance MCP is OAuth-only. Verified against `agent.binance.com` on 2026-09-05:

- Exchange API keys do **not** work — `X-MBX-APIKEY` returns 401.
- The server advertises `grant_types_supported: ["authorization_code"]` and
  nothing else, so there is no unattended way to mint a first token.
- It **does** support `client_id_metadata_document`, so there is no developer
  portal either: Omon publishes its own client metadata at
  `/.well-known/oauth-client` and that URL *is* its `client_id`.

One browser approval, once — not per run, not per restart:

```bash
PUBLIC_BASE_URL=https://your-omon-host npx tsx scripts/mcp-auth.ts
```

The token is written to `.mcp-token.json` (gitignored, mode 600). It is a file
rather than an env var so the long-running process can renew it in place.

---

## Running it

```bash
npm install
cp .env.example .env.local     # fill in what you have; every seam has a fallback
npm run dev
```

Nothing requires funding. Market reads are public, Demo Mode is free, and every
seam falls back to recorded fixtures and *says so* rather than pretending.

```bash
npx tsx scripts/budget-test.ts                        # 16 assertions, no credentials
npx tsx scripts/mcp-smoke.ts                          # Binance MCP, live
npx tsx scripts/indicators-test.ts ../ren-ai          # port vs the original, bar for bar
npx tsx scripts/strategy-smoke.ts --live              # candles -> conviction -> signal -> budget
npx tsx scripts/discovery-smoke.ts                    # 21 checks, the path a stranger's agent walks
npx tsx scripts/b402-test.ts                          # 25 checks, the Binance B402 mapping, offline
node scripts/pay.mjs /api/intel                       # an outside client pays a real 402
```

---

## How it works

```
news (RSS) ─► Intel Agent ─────────────────┐
                                           ├─► Signal Agent ─► budget layer ─► Binance order
Binance MCP ─► prices + candles ─► technicals ┘                    (plain code)
                                           │
                    both sold over x402 ◄──┘
```

- **Intel Agent** turns headlines into `{assets, direction, confidence, thesis}`.
- **Signal Agent** blends that with technical conviction from MCP candles.
- **The budget layer** ([`src/lib/budget.ts`](src/lib/budget.ts)) is plain code
  with no model and no network. The model proposes trades; it never authorises
  them. 16 tests cover it.
- **Both agents' output is sold** behind a real 402, discoverable at
  `/.well-known/x402`.

**Seam discipline:** only `src/lib/*.ts` talk to the outside world, and every
seam reports its own mode (`mcpMode()`, `llmMode()`, `exchangeMode()`) so nothing
on screen is ever a guess about whether it was live.

Design notes and evidence: [`assets/idea-brief.md`](assets/idea-brief.md),
[`assets/architecture-brief.md`](assets/architecture-brief.md),
[`assets/spike-notes.md`](assets/spike-notes.md). Current build state:
[`handoff.md`](handoff.md).
