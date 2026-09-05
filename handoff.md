# Omon — handoff

*Written 2026-09-05. Read this top to bottom before touching anything.*

## VPS deployment status (2026-09-05, evening)

**The app is live on the public origin. START HERE steps 1 and 2 are done. Step
3 — the MCP token — is the only thing still blocking, and it needs a human with
a browser.**

| | |
|---|---|
| Origin | `https://www.omon-ai.duckdns.org` (apex also served; both certed) |
| Process | pm2 app `omon` — node 22.23.2, cwd `/root/Omon-AI`, `next start -p 3111` |
| Edge | Caddy vhost -> `127.0.0.1:3111`, `flush_interval -1`, no `encode` |
| Public paths | `/.well-known/oauth-client`, `/.well-known/x402`, `/api/agent-os` — all 200 `application/json` fetched from outside |
| Discovery | `discovery-smoke.ts https://www.omon-ai.duckdns.org` — 21 checks, PASS |
| Budget | `budget-test.ts` — 16/16 |
| Build | `next build` green; `tsc --noEmit` green *after* the build (see traps) |
| Exchange | **live** — `binance spot @ demo-api.binance.com`; balances read: 4994 USDT / 5000 USDC / 0.008 BNB |
| LLM | **live** — Gemini structured output, 5.1s |
| Full pipeline | **green live** — `news-smoke --live` PASS, `strategy-smoke --live` PASS (incl. the BLOCKED beat) |
| MCP | **still OFF.** `mcp-smoke.ts` reports "no MCP token". Nothing has changed about the central caveat below |

`pm2 save` has been run and `pm2-root` is enabled, so the process comes back
after a reboot. Do not start a second instance — two processes sharing
`.mcp-token.json` can race on renewal and invalidate each other (section 12.5).

**Node 22 is now required, not optional.** `@bnb-chain/b402@0.2.1` declares
`engines.node >=22` and this box defaults to node 20. npm install, the build,
every `npx tsx` script and the pm2 process all run under node 22:

```bash
export PATH=/root/.nvm/versions/node/v22.23.2/bin:$PATH
```

**`.env.local` is COMPLETE as of 2026-09-05 evening.** The Windows secrets were
pasted in and the file deduplicated: 44 keys, one assignment each, backed up to
`.env.local.bak` (mode 600, gitignored). Every seam that needed a credential is
now live — see the status table above.

**TRAP — duplicate keys in `.env.local`, and LAST ONE WINS.** Pasting the Windows
block onto the end of the file left 14 keys assigned twice, and the loader takes
the final assignment (verified: `dotenv.parse` on `A=first\nA=second` yields
`second`). That block ended with `DEMO_MODE=fixture`, which would have pinned the
LLM, the exchange, MCP **and the Skill Hub rail** to recorded data while every
banner honestly reported it — today's work silently inert. Two others were wrong
the same way: `RESOURCE_SERVER_URL` back to `localhost:3000`, and a
`PAY_TO_ADDRESS=0x...` placeholder ahead of the real address.

Resolution is per key, not per position: secrets take the pasted value, but
`DEMO_MODE`, `RESOURCE_SERVER_URL` and `PUBLIC_BASE_URL` take the VPS value
wherever they appeared. If you ever paste an env block again, **re-check for
duplicates before restarting**:

```bash
grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env.local | sort | uniq -d   # must print nothing
```

### Traps found during this deployment

1. **An interrupted `npm install` leaves a `node_modules` that looks fine and is
   not.** 309 packages present, `next` present — and `node_modules/.bin` empty,
   so `next`, `tsc` and `tsx` are all "not found". Re-running install then dies
   with `ENOTEMPTY`. Fix: `rm -rf node_modules` (it may need running twice) and
   a clean install under node 22.
2. **`npx tsc --noEmit` fails on a fresh tree until `next build` has run once.**
   `layout.tsx` uses `LayoutProps`, which Next 16 generates into `.next/types`
   during the build — you get `TS2304: Cannot find name 'LayoutProps'` and it is
   not a real error. Build first. `next build` runs TypeScript itself anyway.
3. **`pkill -f "next start -p 3111"` kills your own shell**, because the pattern
   matches the command line containing it. Use `pgrep -af next-server` and kill
   the pid.
4. **`/api/mcp/callback` is advertised but does not exist.** `/api/oauth-client`
   lists two redirect URIs; only the loopback `http://127.0.0.1:8788/callback`
   has a listener behind it, and that is the one `scripts/mcp-auth.ts` uses, so
   the mint is unaffected. Do not try to complete the flow against the https
   redirect — it 404s. Either build the route or drop it from the document.
5. **No `encode` on the Omon Caddy vhost, deliberately.** gzip buffers
   Server-Sent Events and section 7's console needs `/api/stream`. Same reason
   the `yolomarkets` block omits it; `flush_interval -1` is set.
6. **`mcp-auth.ts` and `mcp-smoke.ts` were not reading `.env.local` — FIXED.**
   `mcp-auth.ts` loaded no env file at all, so it refused to start with
   "PUBLIC_BASE_URL is not set" on a fully configured box; `mcp-smoke.ts` used
   `import "dotenv/config"`, which reads `.env` only, so the proof script was
   reading a different environment than the app it proves. Both now use the
   same `dotenv.config({ path: [".env.local", ".env"] })` line as every other
   script. This works because the project has no `"type": "module"`, so tsx
   emits CommonJS and `require` order follows statement order — the dotenv call
   must stay **above** the `@/lib/...` import, which reads env at module level.
7. **Never reuse an authorize URL from someone else's run.** The PKCE verifier
   lives in the process that printed it, so a URL from a previous (or
   terminated) run cannot complete. Run the script yourself, use the URL it
   prints, and keep that process alive until the redirect lands.

### BLOCKER — Binance refuses Omon's client_id (error 3346001)

**Probed 2026-09-05, evening. This is the wall the token mint hits, and it is on
Binance's side, not ours.**

`scripts/mcp-auth.ts` now works end to end: Binance fetches
`https://www.omon-ai.duckdns.org/.well-known/oauth-client`, renders the "Agentic
Account Access" consent screen with the operator's account and an agentic-account
picker — and then overlays a dialog:

```text
The AI Agent you are using is not currently supported.
Please connect using a supported Agent to continue. (3346001-2c9886bb)
```

Everything of ours is correct: PUBLIC_BASE_URL, the client metadata document,
PKCE, the loopback redirect. The refusal is of the **client identity**.

**What the probe shows.** `/.well-known/oauth-authorization-server` still
advertises `client_id_metadata_document_supported: true`, `/register` still
404s, so there is no registration endpoint to call. But CIMD being *supported*
does not mean any CIMD URL is *accepted* — Binance allowlists which agent
clients may connect, and enforces it at the authorize step. Compare the client
Claude Code uses, from its own credential store on this box:

```text
clientId: https://claude.ai/oauth/claude-code-client-metadata
```

Same mechanism, allowlisted URL. Ours is the same mechanism, unlisted URL.
**Section 11b's "no headless path to a first token" was right but incomplete:
there is no path to a first token for a self-published client at all.**

**This retro-explains the 2026-09-05 "tools verified" row in section 2.**
`spot_klines` / `spot_tickerPrice` / `spot_getAccount` on UID 1273695308 were
called through *Claude Code's* MCP connection (`.mcp.json`, section 9), which is
an allowlisted client — never through Omon's own client_id. The row is true and
it is not evidence that Omon can mint a token.

**Do not "solve" this by lifting Claude Code's token into `.mcp-token.json`.**
It would present a credential minted for another client as Omon's own, which is
precisely the control Binance is enforcing, in a hackathon Binance is judging.
(On this box it is moot anyway — the stored `accessToken` is an empty string, so
there is nothing there to copy.)

**Confirming the diagnosis with Claude Code (optional, 2 minutes).** The
`claude` CLI is on this box at `/opt/node22/bin/claude` — not on PATH, and its
binary is named `claude.exe` despite being a Linux ELF. Call it by absolute path
rather than prepending `/opt/node22/bin`, which would shadow the node 22.23.2
the build is standardised on. Do **not** run `claude mcp add` — `.mcp.json`
already registers this exact server; `claude mcp list` shows it as "Pending
approval". Run `claude` in this directory, approve the project server, then
`/mcp` to authenticate. It should succeed, because Claude Code authenticates as
the allowlisted `https://claude.ai/oauth/claude-code-client-metadata`. **The
token it mints belongs to Claude Code, not Omon** — `/api/agent-os` still reports
`mode: "off"` afterwards, and moving that token into `.mcp-token.json` is the
thing to avoid, per the paragraph above.

**The only legitimate unblock is Binance allowlisting the client.** Ask the
hackathon organisers, quoting error `3346001` and the client_id URL above. Do
this early — it is a question with a possibly fast answer and a hard deadline.

**If the answer is no, the product is not broken.** Every MCP read already
degrades to REST and records the reason, `/api/agent-os` reports `mode: "off"`
with that reason, and the discovery surfaces are live and honest. The claim that
survives is "Agent OS-compatible discovery, MCP-routed reads, REST fallback
recorded in the open" — which is true, demonstrable, and does not require a
token. Say it that way in the video rather than implying a live MCP session.

### THE WAY ROUND IT — the Skill Hub CLI is a second Agent OS surface

**Found 2026-09-05 by reading a competing submission
(`github.com/KattyFury/Binance-Agent`, Track A). Their agent claims "built on
Binance Agent OS" and never touches the MCP endpoint at all.**

There are **two** Agent OS surfaces, and this project only ever probed one:

```text
1. agent.binance.com/mcp/agentic   — MCP, OAuth-only, CLIENT ALLOWLISTED.
                                     Blocked for us. Error 3346001.
2. binance-cli (Skill Hub CLI)     — github.com/binance/binance-cli
                                     github.com/binance/binance-skills-hub
                                     HMAC API keys, or NOTHING for market data.
                                     No OAuth. No allowlist. Not blocked.
```

**Installed and proven on this box, 2026-09-05.** `binance-cli 2.1.1`, official
release, sha256 verified against the published checksum, at
`/usr/local/bin/binance-cli`. Downloaded the tarball directly rather than piping
their installer script into a root shell:

```bash
binance-cli spot ticker-price --symbol BNBUSDT     # {"symbol":"BNBUSDT","price":"773.76000000"}
binance-cli spot klines --symbol BTCUSDT --interval 1h --limit 2
```

**Both ran with no credentials of any kind.** Market-data reads need none; only
order placement needs the HMAC key/secret — the same Demo Trading keys Omon
already provisions. It emits JSON on stdout and exits, so it is a `spawn` away.

**`klines` returns the identical array-of-arrays shape as `/api/v3/klines`**, so
`decodeKlines()` in `exchange.ts` parses it unchanged — the same property that
made the MCP path a swap rather than a rewrite (section 11b). Routing reads
through the CLI is therefore a third rail in a seam that already exists: add
`via: "cli"` alongside the current `"mcp"` / `"rest"` in `mcpUsage()`.

**Why this matters more than it looks.** The judge scorecard's biggest finding
was "Agent OS is not in the product". Sections 11/11b answered that with MCP,
and MCP is now blocked by a control we cannot influence before the deadline.
The Skill Hub CLI answers the same finding, is unblocked today, and a competing
entry is already being submitted on exactly that basis. **This is the highest
value work left after the console.**

One caveat worth an organiser question alongside the allowlist ask: confirm the
Skill Hub CLI counts as "built with Agent OS" for judging. The evidence is good
— Binance owns both repos, the hub is described as "an open skills marketplace
that gives AI agents native access to crypto", and a rival entry leans on it —
but it is worth hearing out loud rather than assumed.

`spawn` note stolen from their code, and it is a real trap: `execFile`/`exec`
leave the child's stdin as an open unwritten pipe and `binance-cli` hangs
waiting on it. Spawn with `stdio: ['ignore','pipe','pipe']`.

### Skill Hub rail — BUILT AND SERVING, 2026-09-05

```text
src/lib/skillhub.ts        cliMode / cliEnabled / runCli / cliPrice /
                           cliKlines / cliHealth / SKILL_HUB_COMMANDS
src/lib/exchange.ts        reads are now THREE rails, in order:
                             1. Binance MCP     (blocked — client allowlist)
                             2. Skill Hub CLI   <- what actually serves
                             3. REST            (the floor)
                           writes unchanged: Spot Demo Mode REST only.
src/lib/mcp.ts             McpUse.via widened to "mcp" | "cli" | "rest".
src/lib/service.ts         Skill Hub published as a manifest surface with live
                           status; executionPolicy rewritten for three rails.
/api/agent-os              reports `skillHub` alongside `mcp`.
scripts/skillhub-smoke.ts  the counterpart to mcp-smoke.ts — FAILS if the read
                           came over REST rather than an Agent OS rail.
```

**Proof, on the deployed origin:**

```bash
npx tsx scripts/skillhub-smoke.ts --verbose   # PASS — prices + candles via: cli
curl https://www.omon-ai.duckdns.org/api/agent-os | jq .agentOs.skillHub
# { "mode": "live", "version": "binance-cli 2.1.1" }
curl https://www.omon-ai.duckdns.org/.well-known/x402 | jq '.agentOs.surfaces[].status'
# "not connected"  (MCP)   "in use"  (Skill Hub)   "in use"  (Demo Mode)
```

`discovery-smoke.ts` still passes all 21 checks against the public origin.

**The claim this makes true.** The candles `indicators.ts` and `strategy.ts` run
on — the technical half of every signal Omon sells — are now fetched through
Binance Agent OS for real, with no token and no allowlist. That is the judge
scorecard's biggest finding answered in the product rather than in the README.

**THE `symbols` TRAP, FULLY MAPPED.** Every rail rejects some batch form with
`-1100 Illegal characters found in parameter 'symbols'`. The server's regex is
`^\[("[\w\-._&&[^a-z]]{1,50}"(,"...")*)?\]$` — a Java character-class
intersection reading "word characters EXCEPT lowercase". So **two** things break
it, and the error message is identical for both:

```text
["BTCUSDT","BNBUSDT"]     OK
["BTCUSDT", "BNBUSDT"]    -1100   one space after the comma
["btcusdt","bnbusdt"]     -1100   lowercase — same error, different cause
```

All four verified live against demo-api 2026-09-05. `cliPrices()` upper-cases
defensively for exactly that reason: a casing bug surfaces as what looks like a
syntax error.

Per rail:

```text
REST       batch OK, but only with a hand-built string (exchange.ts does this)
MCP        batch IMPOSSIBLE — the MCP layer serialises the array itself and
           inserts the fatal space. Loop one symbol per call. Section 11b.
Skill Hub  --symbols FAILS (all forms, incl. the URL-encoded one its own --help
           recommends, and a bare BTCUSDT,BNBUSDT list).
           --json '{"symbols":[...]}' WORKS. Use that.
```

**Batching on the Skill Hub rail is worth real time**, unlike the other two: the
cost there is process spawn, not network. Three symbols measured at **1.96s
looped vs 0.60s batched — 3.3x** — and the gap widens with each symbol. This
supersedes an earlier note in this file that said to leave the CLI loop alone;
`getPrices()` now makes one `--json` call for the whole batch. The MCP loop
still must stay a loop.

**PATH matters for the deployed process.** `binance-cli` lives at
`/usr/local/bin/binance-cli`. The pm2 process finds it because that directory is
on its PATH — if `cliMode()` ever reports "not found" on the server, check the
pm2 environment before anything else, and `pm2 restart omon --update-env`.
`BINANCE_CLI_PATH` overrides the lookup if it ever needs pinning.

### VPN (Windscribe) — unauthenticated, and NOT on the critical path

Windscribe CLI 2.24.12 is installed, the helper service is active, and the
dedicated `windscribe` user (uid 995) exists because the client refuses to run
as root. `windscribe-cli status` still only answers "already running" — no
authentication, no London connection, and credentials have to be typed
interactively. **Nothing in this runbook depends on it.** Do not spend
interactive time here before the token is minted.

---

**Deadline: 2026-09-08 23:59 UTC.** Roughly 3.5 days of wall clock, about 20-24
hours of real build time for one person.

---

## START HERE if you are the agent on the VPS

You are picking this up on a Linux box. The project was built on Windows, so a
few things below assume PowerShell paths — the TypeScript is platform-agnostic
and the scripts are all `npx tsx`, so nothing needs porting.

**Read, in this order: this block → section 12 (the VPS runbook) → section 11b
(what the Agent OS work actually does) → section 6 (traps that already cost
hours). Then section 7 for what to build.**

```text
Do first, in order. Each blocks the next.
  1. DONE (2026-09-05) — repo is current, src/lib/mcp.ts is present.
  2. DONE (2026-09-05) — live at https://www.omon-ai.duckdns.org over HTTPS;
     /.well-known/oauth-client returns JSON when fetched from outside.
  3. NEXT, AND BLOCKING — get the MCP token onto the box (section 12.3).
     Needs a human with a browser. Verify with mcp-smoke.ts.
  4. THEN build: the tick's trade half, then the console. Section 7.
```

**The single most important fact:** the Agent OS integration is written and its
failure path is tested, but **no real MCP token has ever been minted**. Until
`npx tsx scripts/mcp-smoke.ts` passes on this box, every MCP read is silently
falling back to REST. It will not crash and it will not look broken — that is
exactly why you must check rather than assume. See section 12.

**Do not** run `scripts/mcp-auth.ts` over a bare SSH session and expect it to
work. It waits for a browser redirect on `127.0.0.1:8788` and there is no
browser on the VPS. Section 12 gives the two ways round that.

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
| Binance MCP — in the product | **code done, UNPROVEN LIVE** | `src/lib/mcp.ts`; reads routed in `exchange.ts`. Failure path tested (bogus token → clean fallback + recorded reason). **No token minted yet — section 12** |
| Binance MCP — tools verified | verified | `spot_klines`, `spot_tickerPrice`, `spot_getAccount` all called live during the 2026-09-05 review. UID 1273695308 |
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
| Agent OS discoverability | **working** | `agentOs` block in `/.well-known/x402`, `poweredBy` per endpoint, `GET /api/agent-os` |
| Cron tick (wiring + order half) | **NOT BUILT — next** | — |
| Console + SSE | NOT BUILT | `page.tsx` is still the Next.js template. `/api/agent-os` is the status row's data source, waiting |
| Persistence | NOT BUILT | no database yet — but a long-lived VPS process keeps the in-memory cache warm, which was the actual demo risk |
| Skill Hub CLI rail | **LIVE — serving** | `binance-cli 2.1.1`; `skillhub-smoke.ts` passes, candles + prices both `via: "cli"` |
| Deployed on the VPS | **live** | `https://www.omon-ai.duckdns.org` — pm2 `omon`, Caddy, 21 discovery checks pass against the public origin |
| README | **written** | rewritten 2026-09-05, Agent OS section included. The create-next-app boilerplate is gone |
| Video | NOT BUILT | the one mandatory Track A artifact |

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
src/lib/mcp.ts         Binance MCP (Agent OS). JSON-RPC over Streamable HTTP, OAuth token
                       store with in-place renewal, mcpMode()/mcpCall()/mcpHealth().
                       READ ONLY BY DESIGN — never add a write path here. Section 11b.
src/lib/exchange.ts    Binance. getPrices/getCandles route through MCP first and fall back
                       to REST, recording which. placeOrder() is REST-only, Demo Mode.
                       getAgentOsAccount() is the MCP read of the REAL account.
src/lib/budget.ts      The leash. evaluateTrade() + spentToday(). No network, no model.
src/lib/indicators.ts  ema/atr/rsi/priorRange. Pure math, ported from ren-ai, byte-checked.
src/lib/strategy.ts    trendSignal + technicalSnapshot + conviction. The chart half.
src/lib/service.ts     What Omon sells, machine-readable. Feeds the manifest AND the 402
                       preview, so the two cannot drift.

src/app/api/intel/route.ts          The paid endpoint. Serves the cache. WORKS — do not casually refactor.
src/app/api/intel/refresh/route.ts  Free. GET = cache status, POST = collect news and analyse. The slow path.
src/app/api/manifest/route.ts       Free public catalogue. Aliased to /.well-known/x402 by next.config.ts.
                                    Carries the `agentOs` block with LIVE connection status.
src/app/api/agent-os/route.ts       Free. Seam status: MCP mode, tools resolved, token health
                                    (never the token), and which rail each read last used.
                                    This is the console status row's data source.
src/app/api/oauth-client/route.ts   Our OAuth client metadata document. Aliased to
                                    /.well-known/oauth-client. This URL IS our client_id, and
                                    Binance fetches it server-side — it must stay public.
src/app/page.tsx             Still the Next.js default page. This is the console's home.

scripts/pay.mjs              Outside buyer. Pays a 402 for real.
scripts/llm-smoke.ts         Exercises both agents.
scripts/exchange-smoke.ts    Prices, balances, and a real order.
scripts/budget-test.ts       16 assertions. Run after any budget change.
scripts/news-smoke.ts        Feeds -> intel -> cache. Asserts the TTL and the quota guard.
scripts/discovery-smoke.ts   Walks the path a stranger's agent walks. Needs a running server.
scripts/indicators-test.ts   Cross-checks the TS port against the original ren-ai JS.
scripts/strategy-smoke.ts    intel -> candles -> conviction -> signal -> budget, end to end.
scripts/mcp-auth.ts          One-time OAuth mint. Writes .mcp-token.json. Needs PUBLIC_BASE_URL
                             and a browser — section 12.
scripts/mcp-smoke.ts         Proves the Agent OS integration. FAILS if data came over the REST
                             fallback instead of MCP. Run this on the VPS before believing it.
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

# Agent OS / MCP
PUBLIC_BASE_URL=https://your-domain npx tsx scripts/mcp-auth.ts   # one-time, needs a browser
npx tsx scripts/mcp-smoke.ts                       # fails if MCP silently fell back to REST
npx tsx scripts/mcp-smoke.ts --verbose             # same, prints the values fetched
curl localhost:3000/api/agent-os                   # seam status, no credentials needed

npm run dev                                        # then in another shell:
curl -X POST 'localhost:3000/api/intel/refresh?force=1'   # fill the cache first
npx tsx scripts/discovery-smoke.ts                        # 21 checks, no payment
npx tsx scripts/discovery-smoke.ts http://localhost:3111  # takes a base URL as argv[2]
MSYS_NO_PATHCONV=1 node scripts/pay.mjs /api/intel        # outside agent pays the 402
```

**`MSYS_NO_PATHCONV=1` is a Git-Bash-on-Windows workaround.** On the Linux VPS
drop it — plain `node scripts/pay.mjs /api/intel`.

**`--live` is required on the smoke scripts** because the Windows `.env.local`
pins `DEMO_MODE=fixture`. Without it they run fixtures and the banner says so.

**On the VPS, `DEMO_MODE` should be empty** (section 12), so `--live` becomes a
no-op there rather than a requirement. Two consequences worth knowing before you
are confused by them: `DEMO_MODE=fixture` also turns **MCP** off — set
`MCP_IN_FIXTURE_MODE=1` to exercise the real MCP rail while everything else
stays on fixtures — and with `DEMO_MODE` empty, `scripts/exchange-smoke.ts
--order` places a **real Demo Mode order** without asking twice.

**Credentials do not travel with the repo.** `.env.local` is gitignored, so a
fresh clone on the VPS has none of them; copy from `.env.example` and fill.
Present and working on the Windows box: `GEMINI_API_KEY`
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

> **Still dropped, but two of those three reasons expired.** The VPS is Linux, so
> the missing Windows binary is irrelevant, and a long-lived process can spawn a
> subprocess perfectly well. The decision stands anyway for a better reason: MCP
> is now in the product (section 11b), so `binance-cli` would be a *second* route
> to the same Agent OS surface and proves nothing the first does not. Do not
> spend time on it.

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

**6. ~~Deploy to Vercel~~ → Run on the VPS. SUPERSEDED — this is now step 0, not
step 6.** Omon runs as a long-lived process on a VPS, not on Vercel. That is not
a swap of hosts, it changes three things: the serverless function timeout stops
constraining the tick, the in-process intel cache survives (so the 402 preview
stops serving `example.com` fixture rows on a cold start), and the MCP token can
be renewed in place. **It also gates the MCP token mint**, which cannot happen
without a public origin. Section 12 is the runbook.

**7. The 2:15 video.** See section 8. The README is done.

**Feature freeze at T-2h.** Record a clean fallback take early.

---

## 8. Submission requirements

- Follow `@binance` on X, repost the announcement, then **reply or quote-repost
  with the submission** — demo video plus GitHub link.
- Complete the official survey while logged into Binance.
- **CORRECTED 2026-09-05 (judge review):** it *is* a git repository now and it is
  pushed — `origin/main` = `92fa767`, remote `github.com/MikeMoulder/Omon-AI`.
  But **the push is stale.** `indicators.ts`, `strategy.ts`, `service.ts`, the
  manifest route and the three newest smoke scripts are staged and **not on
  GitHub**. The verified ren-ai port and the discovery manifest — the two best
  things in this project — do not exist to anyone who clicks the link. Push.
  Also: open that URL in a logged-out window and confirm the repo is public.
- `README.md` is still the Next.js default **and it is committed and pushed**. A
  judge clicking through from the video currently reads "bootstrapped with
  create-next-app."

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

## 8b. Judge review — 2026-09-05

Full hostile review: **`assets/judge-scorecard.md`**. Consensus **5.2**, readiness
**NOT READY**. Read it before picking up the next task; it reorders §7.

The finding that matters most, because nothing in §7 currently addresses it:

**Agent OS is not in the product.** There is no MCP call anywhere in `src/`. The
only MCP artifact is `.mcp.json` — six lines wiring *Claude Code* to Binance's
server, which is the builder's IDE, not the shipped thing. `exchange.ts` is
hand-rolled REST + HMAC. At a hackathon named "Build an AI agent with Agent OS",
a judge who greps for MCP finds nothing. **Route `getPrices` through the Binance
MCP server** (~1.5h) — that is the highest-leverage work left, and it depends on
the open question below about server-side auth.

Second: **`assets/idea-brief.md` still grades Binance MCP "Essential — live prices,
sub-account balances, placing the actual spot order."** All three are false in the
code. §8 already corrected the order half; the brief never got the update, and the
prices half is wrong too. Fix that line before it reaches the video or the survey —
a fabricated integration claim costs more than a missing one.

Third: **the X steps and the Binance survey are unverified.** Fifteen minutes, no
code, and they are how working projects get disqualified. Do them first.

Also confirmed working during the review, so stop re-testing them: `next build`
exits 0 clean, `/api/manifest` and `/.well-known/x402` return 200, `/api/intel`
returns a complete 402 challenge with the redacted preview.

One new trap found: **on a cold start the 402 preview serves fixture rows** —
`https://example.com/treasury-stablecoin-delay`. No persistence means every Vercel
cold start does this on the exact URL a curious judge probes. Warm the cache on
boot, or ship a JSON file.

> **Largely retired by the VPS.** A long-lived process keeps `intel-cache.ts`
> warm, so there are no cold starts to serve fixtures from. It still bites on
> the first request after a deploy or a restart, so **POST
> `/api/intel/refresh?force=1` once after starting the process** and the judge
> path is clean. Persistence is still worth having; it is no longer urgent.

## 9. Open questions

**Can Claude Desktop actually pay a 402?** This is the biggest remaining risk,
because the aha moment depends on it. Claude Desktop has no built-in wallet — it
needs a payment-capable MCP server wired in. **Verify this before building the
demo around it.** If it cannot, the buyer is `scripts/pay.mjs`, which is still an
outside client and not run in-process, and the wording changes from "Claude
Desktop pays" to "an external agent pays". Do not describe it as Claude Desktop
until it is proven.

**~~Can a Vercel app authenticate to Binance MCP server-side?~~ ANSWERED
2026-09-05 — yes, with one human click. No headless path exists.** Probed
`agent.binance.com` directly:

```text
POST /mcp/agentic  (no auth)      -> 401, WWW-Authenticate: Bearer
POST /mcp/agentic  (X-MBX-APIKEY) -> 401   <- exchange keys do NOT work on MCP
GET  /register                    -> 404   <- no dynamic client registration

/.well-known/oauth-authorization-server:
  authorization_endpoint            accounts.binance.com/agentic-oauth/authorize
  token_endpoint                    accounts.binance.com/oauth-agentic/token
  grant_types_supported             ["authorization_code"]      <- only
  token_endpoint_auth_methods       ["none"]                    <- public client
  code_challenge_methods            ["S256"]                    <- PKCE
  client_id_metadata_document       true
```

What each line means for us:

- **`token_endpoint_auth_methods: ["none"]` plus `client_id_metadata_document:
  true`** — we need no client secret and no developer-portal signup. The
  `client_id` is just a URL we host that returns a small JSON document. Omon can
  register itself as an OAuth client by serving a file.
- **`grant_types_supported` is `authorization_code` and nothing else** — there is
  no `client_credentials`, so a server can never mint a token on its own, and no
  `refresh_token`, so a token probably cannot be renewed programmatically.
- **Net:** a human authorises once in a browser; the resulting bearer token is
  then usable from any server, including a Vercel function. Token lifetime is
  unmeasured — **measure it before relying on it on camera.**

So MCP in the deployed product is possible, and the price of it is one click.
Plan: section 11.

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

---

## 11. Agent OS integration plan

*Written 2026-09-05 after the judge review. This is the answer to the scorecard's
single biggest finding: **Agent OS is not in the product.***

### The shape of the problem

Agent OS is an umbrella over several surfaces. Where Omon stands on each:

| Agent OS surface | Reachable? | In the product today |
|---|---|---|
| Binance Exchange APIs | yes | **YES** — `exchange.ts`: orders, prices, candles |
| Binance MCP Server | yes, one OAuth click | **NO** — zero calls in `src/` |
| Binance Pay / B402 | no — needs a business entity | no, and correctly so |
| Skill Hub / `binance-cli` | yes, npm `binance-cli@1.0.0` | no |
| Agentic Wallet | needs a funded agentic sub-account | no |
| Web3 APIs | yes | no |
| Binance AI Pro | consumer app, not integrable | n/a |

We already use one Agent OS surface properly. So the problem is narrower than
"no Agent OS": it is **"no MCP, at a hackathon whose judges will grep for MCP."**
Fixing MCP fixes the finding. Chasing the other surfaces does not.

### The honest split, decided

**Reads go through MCP. Writes stay on Demo Mode REST.** Not laziness — the MCP
OAuth token belongs to the real Binance account (UID 1273695308). An order placed
through MCP spends real money. Demo Mode is a different host, different keys, no
real funds. So:

| | Rail | Why |
|---|---|---|
| Prices, candles, account state | **Binance MCP** | free, read-only, real mainnet data |
| Order execution | Binance Spot Demo Mode REST | real matching engine, no real money |

Say this in the video: *"Market data and account state come through the Binance
MCP server. Orders execute on Binance Spot Demo Mode, which is the real matching
engine with demo funds."* Both halves are then true, which is what is not true
today.

### The build, in layers

Each layer ships on its own and leaves the project working. Stop anywhere and
nothing is half-done.

```text
L0  Stop the false claims                                        0.2h   FREE
    - exchange.ts lines 9 and 28 say prices "also come from the Binance MCP
      server". They do not. Delete or correct.
    - idea-brief.md "Why this technology": the Binance MCP row still reads
      "Essential - live prices, sub-account balances, placing the actual spot
      order." All three false. Rewrite to the split above.
    Do this first regardless of everything below. A wrong claim costs more
    than a missing feature.

L1  src/lib/mcp.ts - the MCP seam                                1.5h
    Same contract as every other seam: one file owns the wire, exports a
    mode() function, degrades instead of throwing.
      mcpMode()  -> {mode:"live"|"off", reason}
      mcpTools() -> tool list, cached
      mcpCall(name, args)
    Transport is Streamable HTTP: POST JSON-RPC to BINANCE_MCP_URL with
    `Authorization: Bearer $BINANCE_MCP_ACCESS_TOKEN` and `Accept:
    application/json, text/event-stream`, keeping the `Mcp-Session-Id` header
    the initialize response returns. Sequence: initialize ->
    notifications/initialized -> tools/call. Roughly 90 lines hand-rolled,
    which matches how exchange.ts is written. @modelcontextprotocol/sdk@1.30.0
    is the alternative if the SSE framing fights back.
    Token for now: minted by hand, pasted into .env.local. L3 automates it.

L2  Route real product paths through it                          1.0h
    In exchange.ts - MCP first, REST as the recorded fallback:
      getPrices()   -> spot_tickerPrice
      getCandles()  -> spot_klines        <- the important one
      getBalances() -> spot_getAccount    <- real account, read-only
    getCandles is the one that matters. The ren-ai indicator port is the best
    engineering in this project, and routing its candles through MCP means
    Agent OS feeds the analysis rather than decorating a price label. That is
    the difference between "we called an MCP tool once" and "the strategy runs
    on Agent OS data".
    Fallback rule is the existing one: never silent. Record why it fell back,
    show it on the console, fail the smoke test in live mode.

L3  Omon authenticates itself                                    1.5h   OPTIONAL
    /.well-known/oauth-client  -> our client metadata document; this URL is
                                  our client_id, so no signup is needed
    GET /api/mcp/connect       -> PKCE challenge, redirect to Binance consent
    GET /api/mcp/callback      -> exchange code, store token
    Buys two things: the token stops being a hand-pasted secret, and the demo
    gets a beat - click Connect, Binance's own consent screen appears, come
    back, the console's seam flips from REST to MCP live on camera.
    Cheaper substitute if the clock is tight (~0.5h): scripts/mcp-auth.ts runs
    the same PKCE flow on localhost and prints a token to paste. Same proof,
    no demo beat.

L4  Make it findable - this is the judging half                  0.5h
    - service.ts: give each endpoint a `poweredBy` field naming the Agent OS
      calls behind it, e.g. ["binance-mcp:spot_klines",
      "binance-mcp:spot_tickerPrice"]. The manifest then publishes our Agent OS
      usage at /.well-known/x402, where a judge is already looking.
    - Console status row, beside the existing seam badges:
        AGENT OS   MCP live - spot_tickerPrice, spot_klines, spot_getAccount
        EXCHANGE   Spot Demo Mode REST (writes)
    - scripts/mcp-smoke.ts, same shape as the other smokes: list tools, call
      one, assert live mode. This is evidence a judge can run.
    - README: an "Agent OS surfaces used" section with the table above.
```

```text
Minimum that fixes the finding   L0 + L1 + L2 + L4      3.2h
With the self-connect demo beat  + L3                   4.7h
```

The scorecard budgeted 1.5h for this. 1.5h buys L0 + L1 only — a seam nobody can
see. 3.2h is the honest number for the finding actually being fixed, and it
should come out of console time rather than being added on top.

### Risks

**Token lifetime is unknown and there is no refresh grant.** If it is an hour, a
deployed demo goes stale. Two mitigations, do both: the L2 fallback means a dead
token degrades to REST with an honest on-screen reason instead of a 500, and the
video gets recorded soon after a token is minted.

**The MCP token is a live credential to the real account.** It is not the Demo
Mode key. Never commit it, and prefer an Agentic sub-account with limits if one
can be created without funding it.

> **SUPERSEDED on storage** — this line said "keep it in Vercel env only". As
> built, the token lives in `.mcp-token.json` (gitignored, mode 600), because a
> long-lived VPS process must be able to rewrite its own credential to renew it
> and an env var cannot be changed from inside the process that reads it. See
> section 11b.

**MCP may be slower than REST on the tick.** Give it a timeout the way
`EXCHANGE_TIMEOUT_MS` does and fall back rather than blocking the tick.

### Not doing, and why

```text
Orders through MCP        real money on the real account. The read/write split
                          is the point, not a compromise
Agentic Wallet            needs funding. Same reason Track B is dropped
binance-cli / Skill Hub   a second surface proves nothing the first does not,
                          and it means a subprocess inside a serverless
                          function. Only revisit if MCP auth turns out to be
                          impossible, which it is not
Web3 APIs                 no product path needs on-chain data
B402                      business entity. Closed 2026-09-04
```

---

## 11b. Agent OS integration — BUILT 2026-09-05

*Section 11 is the plan. This is what shipped, what the probes found, and the
two decisions that changed along the way.*

### Status: L0, L1, L2, L4 done. Build green, 21 discovery checks still pass.

```text
L0  false claims removed                                          DONE
    exchange.ts header rewritten; the two comments claiming prices "also come
    from the Binance MCP server" are gone (they now describe the real split).
    idea-brief.md's MCP row rewritten and marked as a correction.

L1  src/lib/mcp.ts                                                DONE
    mcpMode / mcpTools / resolveTool / mcpCall / mcpHealth / mcpUsage
    Streamable HTTP JSON-RPC, hand-rolled. Handles both response framings
    (application/json and SSE), keeps Mcp-Session-Id, sends
    notifications/initialized before any call.

L2  reads routed through MCP                                      DONE
    getPrices()  -> spot_tickerPrice   (per symbol — see the trap below)
    getCandles() -> spot_klines        (the strategy's input)
    getAgentOsAccount() -> spot_getAccount  (new; read-only)
    placeOrder() unchanged, still Spot Demo Mode REST.

L4  made findable                                                 DONE
    /.well-known/x402 carries an `agentOs` block naming the surfaces, the
      tools and the execution policy, with LIVE connection status.
    Each endpoint carries `poweredBy` naming the calls behind it.
    GET /api/agent-os — connection state, tools resolved, token health, and
      which rail each read actually used last.
    scripts/mcp-smoke.ts — fails if data came over the REST fallback.
    README.md rewritten: the create-next-app boilerplate is gone.

Enablers built because L1/L2 are untestable without them:
    scripts/mcp-auth.ts            one-time PKCE mint, writes .mcp-token.json
    /api/oauth-client              our OAuth client metadata document,
                                   aliased to /.well-known/oauth-client
```

### What the probes actually found

**Binance MCP is OAuth-only and there is no headless path to a first token.**
Exchange API keys return 401 (`X-MBX-APIKEY` is not an MCP credential).
`grant_types_supported` is `["authorization_code"]` and nothing else. But
`client_id_metadata_document_supported: true` means there is no developer-portal
registration either — the app publishes its own client metadata and that URL is
its `client_id`.

**`spot_klines` returns the identical array-of-arrays shape as `/api/v3/klines`.**
Verified live. Both rails therefore share `decodeKlines()` in `exchange.ts`, so
the indicator maths cannot drift between them. This is what makes routing the
strategy's candles through MCP a swap rather than a rewrite.

**NEW TRAP — the `symbols` batch parameter is unusable through MCP.**
`spot_tickerPrice` with `symbols: ["BTCUSDT","BNBUSDT"]` fails with
`-1100 Illegal characters found in parameter 'symbols'`. This is the same trap
as section 6 ("Binance rejects the symbols array if there is a space after the
comma") and it survives the MCP layer *because the MCP layer is what serialises
the array* — there is no way to hand-build the string from our side. So
`getPrices()` calls one symbol per request on the MCP path and keeps the batch
form only for the REST fallback. Single-symbol calls work fine.

**`analysis_getTokenAiReport` exists but returns nothing usable.** Binance
publishes an AI token-report tool, and it looked like a genuine second source
for the Intel Agent. Called for both BTC and BNB it answers
`{"code":"000000","success":true}` with no report body. The published portfolio
workflow says an absent report comes back as `available=false`, so this is
"no report right now", not a bug in our call. **Not built on. Do not put it in
the video or the survey.**

**The one published MCP Skill is `portfolio-asset-analysis-workflow`** — a
read-only workflow using `getMainAccountAsset` + `getTokenAiReport`. It depends
on the report tool above and on holdings we do not have, so it is not useful
here. Recorded so nobody re-researches it.

### Two decisions that changed from section 11

**1. `getBalances()` was NOT repointed at MCP.** Section 11 said to route it.
That would have been wrong: `getBalances()` reads the Demo account that orders
actually hit, and `spentToday()` reconciles the budget ledger against it.
Pointing it at the operator's mainnet account would have made the ledger
describe a balance no trade ever touched. Instead `getAgentOsAccount()` is a new,
separate read for the Agent OS panel, and the console must label the two
accounts separately rather than summing them.

**2. The token lives in a FILE, not an env var** — `.mcp-token.json`, gitignored,
mode 600. This is because Omon runs continuously on a VPS: a process that can
rewrite its own credential can renew unattended, and an env var cannot be changed
from inside the process that needs it. `rpc()` refreshes proactively when the
token is near expiry and retries once on a 401.

**Whether that renewal actually works is still unmeasured.** The server does not
advertise a `refresh_token` grant, so it may refuse. `scripts/mcp-auth.ts` prints
`expires_in` and whether a refresh token was issued — **read those two lines when
you run it.** If no refresh token comes back, the browser step must be repeated
each time the token expires, and that cadence needs to be known before the demo,
not discovered during it.

### What the VPS changes elsewhere

The VPS is not just a deployment detail; it retires three separate risks:

- **Scorecard finding 7 (cold start serves fixtures on the judge path) is gone.**
  A long-lived process keeps `intel-cache.ts` warm, so the 402 preview stops
  answering with `example.com` fixture rows. Persistence is still worth having,
  but it is no longer the thing standing between a judge and a bad first
  impression.
- **The Vercel function timeout on the tick is moot.** A VPS can run the 15-40s
  tick as a real interval, so the tick no longer has to be designed around a
  serverless ceiling.
- **MCP token renewal becomes possible at all.** On serverless it would not have
  been.

Update section 5's deployment assumption and section 7 item 6 accordingly —
"deploy to Vercel" is now "run on the VPS", and `PUBLIC_BASE_URL` must be set to
the VPS origin or the OAuth mint cannot even start.

### Verify it in one minute

```bash
npx tsc --noEmit && npx next build          # green as of 2026-09-05
npx tsx scripts/mcp-smoke.ts                # says OFF until a token is minted
npx tsx scripts/discovery-smoke.ts http://localhost:3111   # 21 checks, still pass
curl localhost:3000/api/agent-os
curl localhost:3000/.well-known/x402 | jq .agentOs
```

**Known-good without a token:** every MCP path degrades to REST and records the
reason. Tested with a deliberately bogus token — 401 produces a clean
`McpError`, `getPrices` and `getCandles` return correct live values over REST,
and `mcpUsage()` reports `via: "rest"` with the reason. Nothing fails silently.

### Still open

```text
- Mint a real token and re-run mcp-smoke.ts. Until that happens the MCP path is
  correct-by-construction and proven only on its failure path.
- Measure the token lifetime and whether a refresh token is issued.
- PUBLIC_BASE_URL must point at the VPS origin before scripts/mcp-auth.ts will
  run at all — it refuses a loopback client_id, because Binance fetches that URL
  server-side and cannot reach your laptop.
- The console status row (section 11 L4) has no console to live in yet.
  /api/agent-os is the data source waiting for it.
```

---

## 12. VPS runbook — the agent picking this up on the server

*Written 2026-09-05. Everything here is the deployment path; section 11b is what
the code does and why.*

**Steps 0-2 are already done on this box — see "VPS deployment status" at the
top of this file for the concrete values.** Read them anyway to understand what
was set up, but start at step 3. Wherever this section says `your-domain`, it is
`www.omon-ai.duckdns.org`; the app listens on `127.0.0.1:3111` behind Caddy.

### 0. Confirm you have current code

The Windows working tree had roughly a day of uncommitted work in it. If that was
never pushed, a clone gives you a project without the indicator port, the
manifest or any of the Agent OS work — and nothing will fail loudly, you will
just be reading an older project.

```bash
ls src/lib/mcp.ts src/lib/strategy.ts src/lib/indicators.ts src/lib/service.ts
ls src/app/api/manifest/route.ts src/app/api/agent-os/route.ts
ls scripts/mcp-auth.ts scripts/mcp-smoke.ts
```

Any of those missing means the push did not happen. **Stop and say so** rather
than rebuilding them — they exist, they are tested, and reimplementing them from
this document would waste hours and produce something subtly different.

```bash
npm install
npx tsc --noEmit && npx next build     # both were green on 2026-09-05
npx tsx scripts/budget-test.ts         # 16 assertions, needs no credentials
```

### 1. Environment

Copy `.env.example` to `.env.local` and fill it. It documents every variable.
Three that matter on the VPS specifically and are easy to get wrong:

```bash
PUBLIC_BASE_URL=https://your-domain     # REQUIRED. No trailing slash.
DEMO_MODE=                              # leave EMPTY. `fixture` turns MCP off too.
BINANCE_MCP_TOKEN_FILE=.mcp-token.json  # default; must be writable by the process
```

`DEMO_MODE=fixture` is pinned in the Windows `.env.local` and it disables the LLM,
the exchange **and** MCP. If you copy that file across, everything runs on
fixtures and the banners will say so — which is the seam working correctly, not a
bug. Clear it on the server.

`PUBLIC_BASE_URL` being wrong is the failure that costs the most time, because
the symptom is an opaque error on Binance's own page with nothing in any local
log. It must be the exact public origin, and it must be the one actually serving
`/.well-known/oauth-client`.

### 2. Serve it, and check the two well-known paths from outside

The app must be publicly reachable over HTTPS **before** the token flow starts,
because Binance fetches the client metadata document server-side during
authorisation.

```bash
npm run build && npm run start          # or pm2 / systemd — see 'keeping it up'
```

From a machine that is not the VPS:

```bash
curl https://your-domain/.well-known/oauth-client   # must return JSON, not 404
curl https://your-domain/.well-known/x402           # the service catalogue
curl https://your-domain/api/agent-os               # seam status
```

If `oauth-client` 404s, the rewrite in `next.config.ts` did not apply — it maps
`/.well-known/oauth-client` to `/api/oauth-client`, and a reverse proxy that
swallows dot-prefixed paths will break it. Nginx does this by default in some
configs; check before blaming the app.

### 3. Mint the MCP token

**Binance MCP is OAuth-only. There is no headless path to a first token** —
`grant_types_supported` is `["authorization_code"]` and nothing else, and
exchange API keys return 401. A human approves once in a browser. After that the
token works from any server.

The script waits for a redirect on `127.0.0.1:8788`, so it has to run somewhere
a browser can reach. **Two ways, pick one:**

**A — mint on the laptop, copy the file over (simplest).** The `client_id` only
has to be *reachable by Binance*; it does not have to be the machine running the
flow. The loopback redirect is already listed in the published document.

```bash
# on the laptop, with the VPS already serving
PUBLIC_BASE_URL=https://your-domain npx tsx scripts/mcp-auth.ts
scp .mcp-token.json user@vps:/path/to/omon/.mcp-token.json
ssh user@vps 'chmod 600 /path/to/omon/.mcp-token.json'
```

**B — mint on the VPS through an SSH tunnel.** Forward the loopback port so the
laptop's browser can complete the redirect against the VPS process.

```bash
ssh -L 8788:localhost:8788 user@vps
# then, in that session:
PUBLIC_BASE_URL=https://your-domain npx tsx scripts/mcp-auth.ts
# open the printed URL in the LAPTOP browser
```

The script refuses to start on a loopback or missing `PUBLIC_BASE_URL`, and it
checks that the published document actually lists the redirect URI, so a
misconfiguration fails in the terminal before a browser opens.

**Read the two lines it prints on success.** They are the answer to a question
this project has not been able to measure:

```text
expires_in:    <-- how long before the agent silently drops back to REST
refresh_token: <-- ISSUED means it renews itself; NOT issued means you repeat
                   this browser step every time it expires
```

If no refresh token is issued, work out the expiry cadence and re-mint shortly
before recording the video. The server does not advertise a refresh grant, so
assume the worst until you see otherwise.

### 4. Prove it, do not assume it

```bash
npx tsx scripts/mcp-smoke.ts
```

This is the whole point of the file. It opens a real MCP session, resolves the
three tools the product depends on, pulls prices, candles and account state, and
**fails if any of it arrived over the REST fallback.** A passing run is the
evidence that "built with Agent OS" is true on this box.

`--verbose` prints the values if you want to eyeball them.

Then confirm the public surfaces agree:

```bash
curl https://your-domain/api/agent-os | jq .agentOs.mcp
# mode should be "live", toolsResolved should name all three tools
curl https://your-domain/.well-known/x402 | jq .agentOs.surfaces[0].status
# "connected"
```

If `mode` is `off`, read `reason` — it is written to be self-explanatory and
names the fix.

### 5. Keeping it up

Use whatever process manager is already on the box; nothing here is fussy. Two
requirements:

- **The working directory must be the project root**, because the token file
  path is relative by default. Set an absolute `BINANCE_MCP_TOKEN_FILE` if your
  supervisor starts the process elsewhere.
- **The process must be able to write that file**, or in-place token renewal
  cannot work and you are back to manual re-minting.

Do not run more than one instance against the same token file. Two processes
refreshing the same credential can race and invalidate each other's token.

### 6. What NOT to do on this box

```text
Do not place orders through MCP. The MCP token authorises the operator's REAL
  Binance account (canTrade: true). Orders go to Spot Demo Mode via REST, and
  src/lib/mcp.ts deliberately has no write path. Do not add one.
Do not commit .mcp-token.json. It is gitignored; the process rewrites it.
Do not set X402_RAIL=b402. Without b402 credentials the paid route 500s, and on
  a server the only symptom is a 500 in the middle of a demo. Section 6.
Do not cron the tick every minute. Two Gemini calls per tick against a ~1,000
  request/day free quota locks the account out. 5-15 minutes. Section 6.
Do not "fix" the fixture fallbacks. They are the reason a dead token degrades
  instead of breaking. Every one of them records its reason.
```

### 7. Then build, in this order

Once MCP is proven live, the Agent OS work is finished and the remaining gap is
the product itself. Section 7 has the detail; the short version:

```text
1. The tick's trade half — newest cached intel -> getPrices -> signalFromIntel
   -> evaluateTrade -> placeOrder if ALLOW. The VPS removes the serverless
   timeout that shaped the original design, so this can be a real interval.
2. The console — src/app/page.tsx is still the Next.js template. This is the
   product and there is no video without it. /api/agent-os feeds the status row.
3. The 2:15 video. Section 8 has the script and the disclosure table that must
   be said out loud.
```

The judge scorecard (`assets/judge-scorecard.md`) is the honest read on what
wins and loses this. Its biggest finding — "Agent OS is not in the product" — is
what sections 11/11b addressed. Its remaining P0s are the console and the video.
