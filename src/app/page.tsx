/**
 * The console. One screen, and the only thing anyone actually looks at.
 *
 * It answers four questions in the order a stranger asks them, and it answers
 * them in words a stranger already knows:
 *
 *   1. Is this alive?     — the heartbeat, the countdown, the moving marks.
 *   2. Is this real?      — one honest pill per seam, and the rail each read used.
 *   3. Is it making money? — profit and loss, marked against the prices on screen.
 *   4. Is it safe?        — the daily cap, drawn, and every refusal kept.
 *
 * ## Plain language is a feature here, not a nicety
 *
 * The first version of this screen was written in the vocabulary of the people
 * who built it — "Traded · 24h", "beat", "seam", six unlabelled status dots —
 * and the first thing anyone said about it was that they could not tell what
 * they were looking at, or whether it had made any money. Both complaints were
 * about the same thing: the screen showed activity and never showed a result.
 *
 * So: every number carries a sentence saying what it is, every column carries a
 * heading saying which question it answers, and the "How to read this" panel
 * spells out the whole vocabulary in one place. Nothing on this page should
 * require the reader to have read the source.
 *
 * ## Profit is the headline
 *
 * P&L is the largest figure and the leftmost card, because "did it work" beats
 * "did it do something". It is deliberately NOT netted against x402 revenue:
 * those are different rails — USDC on Base Sepolia in, demo USDT out — and one
 * combined number would imply a settlement between them that does not exist.
 * They sit side by side, each labelled with its own rail.
 *
 * Data is one full snapshot per beat over SSE from /api/stream. There is no
 * client-side state to drift — every number came from the server within the
 * last two seconds, and the connection pill says so when it did not.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleSnapshot } from "@/lib/console-state";

type Connection = "connecting" | "live" | "reconnecting";

function useSnapshot(): { snapshot: ConsoleSnapshot | null; connection: Connection } {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    const source = new EventSource("/api/stream");

    source.onmessage = (event) => {
      try {
        setSnapshot(JSON.parse(event.data) as ConsoleSnapshot);
        setConnection("live");
      } catch {
        // A truncated frame is not worth tearing the connection down for.
      }
    };

    // EventSource reconnects by itself; the pill exists so a stalled feed during
    // a recording is visible rather than looking like a system that went quiet.
    source.onerror = () => setConnection("reconnecting");

    return () => source.close();
  }, []);

  return { snapshot, connection };
}

/**
 * A clock that ticks locally between snapshots.
 *
 * The countdown has to move every second, but snapshots arrive every two — so
 * it is computed from the server's `nextAt` against a local clock rather than
 * being pushed. Drift is bounded by the next snapshot correcting it.
 */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Ids seen in a previous beat. Anything absent from it is new, and flashes. */
function useNewRows(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    // The first beat is not "new" — everything would flash at once on load.
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current!.has(id));
    if (added.length === 0) return;

    for (const id of added) seen.current.add(id);
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), 2600);
    return () => clearTimeout(timer);
  }, [ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  return fresh;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Money with its sign kept, because on a P&L the sign IS the information.
 * `$0.00` and `-$0.00` both read as flat, so tiny magnitudes lose the sign.
 */
function signedUsd(n: number): string {
  if (Math.abs(n) < 0.005) return "$0.00";
  return `${n > 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function signedPct(fraction: number): string {
  const pct = fraction * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${Math.abs(pct).toFixed(2)}%`;
}

/** Base quantities span BTC (0.00011) and BNB (0.017); significant digits suit both. */
const qty = (n: number) => n.toLocaleString(undefined, { maximumSignificantDigits: 6 });

const mark = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 2 : 4 });

/** emerald above zero, rose below, plain at flat. Used for every P&L figure. */
function tint(n: number): string {
  if (n > 0.005) return "text-emerald-300";
  if (n < -0.005) return "text-rose-300";
  return "text-zinc-300";
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function countdown(iso: string | null, now: number): string {
  if (!iso) return "—";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return "due";
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/**
 * One seam's honesty, with the word on it.
 *
 * The mode is spelled out rather than encoded in a dot colour alone: "Exchange
 * live" and "Exchange fixture" are the difference between a real order and a
 * recorded one, and that cannot be something the viewer has to hover to learn.
 */
function Pill({ label, mode, reason }: { label: string; mode: string; reason: string }) {
  const live = mode === "live" || mode === "in use";
  return (
    <div
      title={`${label}: ${reason}`}
      className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1"
    >
      <span
        className={`h-1 w-1 rounded-full ${live ? "bg-emerald-400" : "bg-amber-500"}`}
        aria-hidden
      />
      <span className="text-[10px] font-medium tracking-wide text-zinc-400">{label}</span>
      <span className={`text-[10px] ${live ? "text-emerald-400/80" : "text-amber-400/80"}`}>
        {mode}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  sub,
  tone = "plain",
  ink,
}: {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  tone?: "plain" | "money" | "warn" | "hero";
  /** Overrides the tone's colour — the P&L card is green or red by its own sign. */
  ink?: string;
}) {
  const ring =
    tone === "money"
      ? "border-emerald-400/25 bg-emerald-400/[0.05]"
      : tone === "warn"
        ? "border-amber-400/25 bg-amber-400/[0.04]"
        : tone === "hero"
          ? "border-white/[0.14] bg-white/[0.04]"
          : "border-white/[0.07] bg-white/[0.02]";
  const defaultInk = tone === "money" ? "text-emerald-300" : tone === "warn" ? "text-amber-200" : "text-zinc-100";

  return (
    <div className={`rounded-lg border px-4 py-3 ${ring}`}>
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">{label}</p>
      <p
        className={`mt-1.5 font-mono text-[26px] font-semibold leading-none tabular-nums ${ink ?? defaultInk}`}
      >
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-zinc-500">{unit}</span> : null}
      </p>
      <p className="mt-1.5 truncate text-[10px] text-zinc-500" title={sub}>
        {sub}
      </p>
    </div>
  );
}

/**
 * A panel, with a sentence under its title saying what it is.
 *
 * `help` is not optional decoration — it is the fix for "I do not understand
 * the interface". Every panel says, in one line, what a reader is looking at.
 */
function Panel({
  title,
  help,
  note,
  children,
}: {
  title: string;
  help: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.015]">
      <header className="shrink-0 border-b border-white/[0.07] px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-300">
            {title}
          </h2>
          {note ? <span className="font-mono text-[10px] text-zinc-600">{note}</span> : null}
        </div>
        <p className="mt-0.5 truncate text-[10px] text-zinc-500" title={help}>
          {help}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-8 text-center text-[11px] leading-relaxed text-zinc-600">{children}</p>
  );
}

/** The column headings. Three questions, in the order the pipeline answers them. */
function ColumnLabel({ step, children }: { step: string; children: React.ReactNode }) {
  return (
    <p className="shrink-0 px-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-600">
      <span className="text-zinc-500">{step}</span> {children}
    </p>
  );
}

/**
 * The vocabulary, in one place, closed by default.
 *
 * Written for someone who has never seen this screen: every term it defines is
 * a term that appears on the page, and no definition assumes another one.
 */
function Legend() {
  const rows: Array<[string, string]> = [
    [
      "Profit / loss",
      "What the trades are worth versus what they cost. Realised is profit already booked by selling; open is profit that only exists while the position is still held, and it moves with the price.",
    ],
    [
      "Open positions",
      "Crypto Omon currently holds from its own buys, valued at the live price shown at the top of the page.",
    ],
    [
      "Earned from data sales",
      "A separate rail, and separate money. Other agents pay Omon over x402 for its news analysis. Revenue, not trading profit — the two are never added together.",
    ],
    [
      "Budget used today",
      "Total money placed into trades in the last 24 hours against the hard daily cap. This is turnover, not a loss — buying $10 of BTC uses $10 of budget and costs you nothing but the spread.",
    ],
    [
      "Beat",
      "One full pass of the pipeline: read the news, form a view, propose a trade, check it against the limits, and place it or refuse it. Runs automatically on a timer.",
    ],
    [
      "Refused / blocked",
      "A trade the Signal Agent proposed and the budget layer would not allow. Kept on screen deliberately — a refusal nobody can see is the same as having no limits at all.",
    ],
    [
      "Demo balance",
      "The Binance Spot Demo Mode account the orders actually hit. Real exchange, real order book, no real money.",
    ],
    [
      "Status pills",
      "One per moving part. Green 'live' means it is really calling that service; amber 'fixture' means it is serving recorded data and saying so.",
    ],
    [
      "Saved / not saved",
      "Bottom right. Every purchase, refusal and fill is written to disk as it happens and read back on restart, so the history and the P&L survive a restart. If it says NOT SAVED, this process is running from memory alone and a restart will erase it.",
    ],
  ];

  return (
    <div className="grid gap-x-6 gap-y-2 rounded-lg border border-white/[0.09] bg-white/[0.03] px-4 py-3 md:grid-cols-2">
      {rows.map(([term, meaning]) => (
        <div key={term}>
          <p className="text-[11px] font-semibold text-zinc-200">{term}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">{meaning}</p>
        </div>
      ))}
    </div>
  );
}

export default function Console() {
  const { snapshot, connection } = useSnapshot();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);

  const newPurchases = useNewRows((snapshot?.money.in ?? []).map((p) => p.id));
  const newActions = useNewRows((snapshot?.money.out ?? []).map((a) => a.id));

  const run = useCallback(async (label: string, url: string) => {
    setBusy(label);
    setNote(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      setNote(
        typeof body.skipped === "string" && body.skipped ? `${body.skipped}` : `${label} — done`,
      );
    } catch (err) {
      setNote(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  if (!snapshot) {
    return (
      <main className="flex flex-1 items-center justify-center bg-[#08090b] text-xs text-zinc-600">
        connecting to /api/stream…
      </main>
    );
  }

  const { seams, ledger, limits, payment, pnl, scheduler, lastTick, storage } = snapshot;
  const spentPct = Math.min(100, (ledger.spentTodayUsd / Math.max(1, limits.dailyTradeUsd)) * 100);
  const quote = snapshot.balances?.USDT ?? null;

  const beatLine = lastTick
    ? lastTick.order
      ? `${lastTick.order.side} ${lastTick.order.symbol} ${lastTick.order.status} · order ${lastTick.order.orderId}`
      : lastTick.decision
        ? `${lastTick.decision.decision} — ${lastTick.decision.reason}`
        : (lastTick.skipped ?? "no verdict")
    : "waiting for the first beat";

  // What the P&L card says underneath itself. It has to explain the split
  // between booked and open profit without the reader opening the legend.
  const pnlSub =
    pnl.fillCount === 0
      ? "no trades filled yet — this fills on the first buy"
      : `${signedUsd(pnl.realizedUsd)} realised · ${signedUsd(pnl.unrealizedUsd)} open · from ${pnl.fillCount} fill${pnl.fillCount === 1 ? "" : "s"}`;

  return (
    <main className="flex flex-1 flex-col gap-2.5 bg-[#08090b] p-3 text-zinc-100">
      <style>{`
        @keyframes omon-flash { 0% { background-color: rgb(16 185 129 / 0.30); } 100% { background-color: transparent; } }
        .omon-new { animation: omon-flash 2.4s ease-out; }
        @keyframes omon-beat { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
        .omon-busy { animation: omon-beat 1s ease-in-out infinite; }
      `}</style>

      {/* Header — what this is, in one sentence, before any number. */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.07] pb-2.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-base font-semibold tracking-tight">
            Omon<span className="text-emerald-400">.</span>
          </h1>
          <p className="hidden text-[11px] text-zinc-400 md:block">
            Every {Math.round(scheduler.intervalMs / 60000)} minutes it reads crypto news, forms a
            view, proposes one trade, checks it against a {usd(limits.dailyTradeUsd)}/day limit, and
            places it on Binance Spot Demo. Other agents pay it for the analysis.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            onClick={() => setLegend((open) => !open)}
            className={`rounded-md border px-2 py-1 text-[10px] font-medium transition ${
              legend
                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                : "border-white/[0.09] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.09]"
            }`}
          >
            {legend ? "Hide guide" : "How to read this"}
          </button>
          <Pill label="Intel" mode={seams.intelAgent.mode} reason={seams.intelAgent.reason} />
          <Pill label="Signal" mode={seams.signalAgent.mode} reason={seams.signalAgent.reason} />
          <Pill label="News" mode={seams.news.mode} reason={seams.news.reason} />
          <Pill label="Exchange" mode={seams.exchange.mode} reason={seams.exchange.reason} />
          <Pill label="MCP" mode={seams.mcp.mode} reason={seams.mcp.reason} />
          <Pill label="Skill Hub" mode={seams.skillHub.mode} reason={seams.skillHub.reason} />
          <div
            className="ml-1 flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1"
            title={`stream ${connection}`}
          >
            <span
              className={`h-1 w-1 rounded-full ${
                connection === "live" ? "animate-pulse bg-emerald-400" : "bg-amber-500"
              }`}
              aria-hidden
            />
            <span className="font-mono text-[10px] text-zinc-500">{connection}</span>
          </div>
        </div>
      </header>

      {legend ? <Legend /> : null}

      {/* Live marks. Not decoration — these are the prices the P&L is marked at. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-0.5 font-mono text-[11px]">
        <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">Live prices</span>
        {Object.entries(snapshot.prices).map(([symbol, price]) => (
          <span key={symbol} className="text-zinc-500">
            {symbol.replace("USDT", "")}
            <span className="ml-1.5 tabular-nums text-zinc-300">{mark(Number(price))}</span>
          </span>
        ))}
        <span className="ml-auto text-[10px] text-zinc-600" title="which rail served each market read">
          market data via{" "}
          {Object.entries(snapshot.usage)
            .map(([k, v]) => `${k}→${v.via}`)
            .join("  ") || "nothing yet"}
        </span>
      </div>

      {/* The four numbers that answer "is this working, and did it make money". */}
      <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat
          label="Profit / loss · trading"
          value={signedUsd(pnl.totalUsd)}
          tone="hero"
          ink={tint(pnl.totalUsd)}
          sub={pnlSub}
        />
        <Stat
          label="Open positions"
          value={pnl.openCount === 0 ? "flat" : usd(pnl.marketValueUsd)}
          sub={
            pnl.openCount === 0
              ? "holding nothing right now"
              : `${pnl.openCount} held · cost ${usd(pnl.costBasisUsd)} · now worth ${usd(pnl.marketValueUsd)}`
          }
        />
        <Stat
          label="Earned from data sales · 24h"
          value={usd(ledger.earnedTodayUsd)}
          tone="money"
          sub={`${ledger.purchaseCount} agent purchase${ledger.purchaseCount === 1 ? "" : "s"} · ${payment.price} ${payment.token} each on ${payment.network}`}
        />
        <Stat
          label="Budget used today"
          value={usd(ledger.spentTodayUsd)}
          tone={spentPct > 80 ? "warn" : "plain"}
          sub={`of ${usd(limits.dailyTradeUsd)} allowed · ${ledger.orderCount} placed · ${ledger.blockedCount} refused`}
        />
      </section>

      {/* The heartbeat, the account, and what the last pass concluded. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 ${scheduler.busy ? "omon-busy" : "opacity-40"}`}
          aria-hidden
        />
        <span className="shrink-0 text-[10px] text-zinc-400">
          {scheduler.running ? (
            <>
              Next run in{" "}
              <span className="font-mono text-zinc-200">
                {scheduler.busy ? "running now" : countdown(scheduler.nextAt, now)}
              </span>{" "}
              <span className="text-zinc-600">· {scheduler.beats} runs total · automatic</span>
            </>
          ) : (
            <span className="text-amber-300">paused — TICK_AUTOSTART=0, use the buttons below</span>
          )}
        </span>
        <span className="hidden shrink-0 text-zinc-700 sm:inline">|</span>
        <span className="shrink-0 text-[10px] text-zinc-400">
          Demo account{" "}
          <span className="font-mono text-zinc-200">
            {quote === null ? "—" : `${Number(quote).toFixed(2)} USDT`}
          </span>
          {snapshot.balancesError ? (
            <span className="text-amber-400/80"> · stale</span>
          ) : null}
        </span>
        <span className="hidden shrink-0 text-zinc-700 sm:inline">|</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-400">
          Last run <span className="font-mono text-zinc-300">{beatLine}</span>
        </span>
        {lastTick ? (
          <span className="shrink-0 font-mono text-[10px] text-zinc-600">
            {lastTick.source} · {lastTick.tookMs}ms · {ago(lastTick.at, now)} ago
          </span>
        ) : null}
      </div>

      {/* The leash, drawn. Never a bare number — the cap is the claim. */}
      <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[10px] text-zinc-400">
            Spending limits — enforced in code, not by the model
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            {usd(ledger.spentTodayUsd)} of {usd(limits.dailyTradeUsd)} used today ·{" "}
            {usd(limits.maxTradeUsd)} max per trade · only {limits.allowedSymbols.join(" ")}
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className={`h-full rounded-full transition-all duration-700 ${spentPct > 80 ? "bg-amber-400" : "bg-emerald-400"}`}
            style={{ width: `${spentPct}%` }}
          />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 lg:grid-cols-[1.15fr_1fr_1fr]">
        {/* 1 — what it read, and what it made of it. */}
        <div className="flex min-h-0 flex-col gap-1.5">
          <ColumnLabel step="1 ·">What it read</ColumnLabel>
          <div className="grid min-h-0 flex-1 grid-rows-2 gap-2.5">
            <Panel
              title="News, analysed"
              help="Headlines the Intel Agent read, and which way it thinks each one points."
              note={
                snapshot.intel.source === "fixture"
                  ? "recorded data — cache cold"
                  : `${snapshot.intel.status.rows} rows · ${snapshot.intel.status.fresh ? "fresh" : "stale"}`
              }
            >
              {snapshot.intel.rows.length === 0 ? (
                <Empty>no news read yet — the first run fills this</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {snapshot.intel.rows.map((row) => {
                    const tone =
                      row.direction === "bullish"
                        ? "border-l-emerald-400/60"
                        : row.direction === "bearish"
                          ? "border-l-rose-400/60"
                          : "border-l-zinc-600";
                    return (
                      <li
                        key={row.id}
                        className={`rounded-r border-l-2 bg-white/[0.02] py-2 pl-2.5 pr-2 ${tone}`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={`text-[9px] font-bold uppercase tracking-wider ${
                              row.direction === "bullish"
                                ? "text-emerald-400"
                                : row.direction === "bearish"
                                  ? "text-rose-400"
                                  : "text-zinc-500"
                            }`}
                            title="which way this story points, and how sure the model is"
                          >
                            {row.direction} · {Math.round(row.confidence * 100)}% sure
                          </span>
                          <span className="font-mono text-[9px] text-zinc-600">
                            {row.assets.join(" ")} · {ago(row.createdAt, now)}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] font-medium leading-snug text-zinc-200">
                          {row.headline}
                        </p>
                        <p className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-zinc-500">
                          {row.summary}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel
              title="Trade ideas"
              help="What the Signal Agent wants to do about that news. Proposals only — nothing here has been placed."
              note={
                snapshot.signals.source === "empty"
                  ? "none yet"
                  : `${snapshot.signals.status.rows} rows · ${snapshot.signals.status.fresh ? "fresh" : "stale"}`
              }
            >
              {snapshot.signals.rows.length === 0 ? (
                <Empty>
                  {snapshot.signals.status.lastError ?? "no idea yet — news is read first"}
                </Empty>
              ) : (
                <ul className="space-y-1.5">
                  {snapshot.signals.rows.map((row) => (
                    <li
                      key={row.id}
                      className="rounded border border-white/[0.06] bg-white/[0.02] p-2.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-xs font-semibold tabular-nums">
                          <span className={row.side === "BUY" ? "text-emerald-400" : "text-rose-400"}>
                            {row.side}
                          </span>{" "}
                          {row.symbol}
                          <span className="ml-1.5 text-zinc-400">{usd(row.sizeUsd)}</span>
                        </span>
                        <span className="font-mono text-[9px] text-zinc-600">
                          {ago(row.createdAt, now)}
                        </span>
                      </div>
                      {row.convictionLabel ? (
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span
                            title="how strongly the news and the chart agreed"
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                              row.convictionLabel === "high"
                                ? "bg-emerald-400/15 text-emerald-300"
                                : row.convictionLabel === "medium"
                                  ? "bg-amber-400/15 text-amber-300"
                                  : "bg-white/[0.06] text-zinc-400"
                            }`}
                          >
                            {row.convictionLabel} conviction
                            {typeof row.convictionScore === "number"
                              ? ` ${row.convictionScore.toFixed(2)}`
                              : ""}
                          </span>
                          {row.aligned === false ? (
                            <span className="text-[9px] text-zinc-500">news vs chart disagree</span>
                          ) : null}
                        </div>
                      ) : null}
                      <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400">{row.thesis}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>

        {/* 2 — what it actually did with money. */}
        <div className="flex min-h-0 flex-col gap-1.5">
          <ColumnLabel step="2 ·">What it did</ColumnLabel>
          <Panel
            title="Orders placed and refused"
            help="Every proposal that reached the spending limits, and the verdict on it. Red rows never reached the exchange."
            note={`${ledger.orderCount} placed · ${ledger.blockedCount} refused`}
          >
            {snapshot.money.out.length === 0 ? (
              <Empty>nothing traded yet — the next run decides</Empty>
            ) : (
              <ul className="space-y-1.5">
                {snapshot.money.out.map((row) => {
                  const filled = row.decision === "ALLOW" && row.orderId !== null;
                  return (
                    <li
                      key={row.id}
                      className={`rounded border p-2 ${
                        filled
                          ? "border-white/[0.08] bg-white/[0.02]"
                          : "border-rose-400/25 bg-rose-400/[0.05]"
                      } ${newActions.has(row.id) ? "omon-new" : ""}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold tabular-nums">
                          {String(row.payload.side ?? "")} {String(row.payload.symbol ?? "")}
                          <span className="ml-1.5 text-zinc-400">
                            {usd(Number(row.payload.sizeUsd ?? 0))}
                          </span>
                        </span>
                        <span
                          className={`text-[9px] font-bold uppercase tracking-wider ${
                            filled ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {filled ? "placed" : "refused"}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[9px] leading-relaxed text-zinc-500">{row.reason}</p>
                      <p className="font-mono text-[9px] text-zinc-600">
                        {row.orderId ? `order ${row.orderId} · ` : ""}
                        {ago(row.createdAt, now)} ago
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        {/* 3 — what the result is worth, on both rails. */}
        <div className="flex min-h-0 flex-col gap-1.5">
          <ColumnLabel step="3 ·">What it is worth</ColumnLabel>
          <div className="grid min-h-0 flex-1 grid-rows-2 gap-2.5">
            <Panel
              title="Positions & profit"
              help="What Omon holds, what it paid, and what it is worth at the live price above."
              note={
                pnl.fillCount === 0
                  ? "no fills yet"
                  : `${pnl.fillCount} fill${pnl.fillCount === 1 ? "" : "s"}`
              }
            >
              {pnl.positions.length === 0 ? (
                <Empty>
                  no positions yet. A run that gets past the limits buys here, and the profit on
                  that buy appears in this panel and in the card above.
                </Empty>
              ) : (
                <ul className="space-y-1.5">
                  {pnl.positions.map((row) => {
                    const open = row.qty > 0;
                    const shown = open ? (row.unrealizedUsd ?? 0) : row.realizedUsd;
                    return (
                      <li
                        key={row.symbol}
                        className="rounded border border-white/[0.06] bg-white/[0.02] p-2.5"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11px] font-semibold text-zinc-200">
                            {row.symbol.replace("USDT", "")}
                            <span className="ml-1.5 text-[10px] font-normal text-zinc-500">
                              {open ? "open" : "closed"}
                            </span>
                          </span>
                          <span
                            className={`font-mono text-xs font-semibold tabular-nums ${tint(shown)}`}
                          >
                            {row.markPrice === null && open
                              ? "no price"
                              : signedUsd(shown)}
                            {open && row.unrealizedPct !== null ? (
                              <span className="ml-1 text-[10px] font-normal">
                                {signedPct(row.unrealizedPct)}
                              </span>
                            ) : null}
                          </span>
                        </div>

                        {open ? (
                          <>
                            <p className="mt-1 font-mono text-[10px] tabular-nums text-zinc-400">
                              {qty(row.qty)} {row.symbol.replace("USDT", "")} · bought at{" "}
                              {mark(row.avgCostUsd)}
                              {row.markPrice !== null ? ` · now ${mark(row.markPrice)}` : ""}
                            </p>
                            <p className="font-mono text-[10px] tabular-nums text-zinc-600">
                              paid {usd(row.costBasisUsd)}
                              {row.marketValueUsd !== null
                                ? ` → worth ${usd(row.marketValueUsd)}`
                                : " → not priced this beat"}
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 font-mono text-[10px] text-zinc-500">
                            fully sold · {signedUsd(row.realizedUsd)} booked
                          </p>
                        )}

                        {open && Math.abs(row.realizedUsd) >= 0.005 ? (
                          <p className="font-mono text-[10px] text-zinc-600">
                            plus {signedUsd(row.realizedUsd)} already booked on earlier sells
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {Object.keys(pnl.unbasedSells).length > 0 ? (
                <p className="mt-2 rounded border border-amber-400/20 bg-amber-400/[0.04] px-2 py-1.5 text-[10px] leading-relaxed text-amber-200/80">
                  Some sold quantity was already in the demo account before Omon started, so it has
                  no cost here and earns no profit here. The figures cover Omon&apos;s own trades only.
                </p>
              ) : null}
            </Panel>

            <Panel
              title="Paid to Omon — the other rail"
              help="Outside agents buying Omon's analysis over x402. Revenue, kept separate from trading profit."
              note={`${ledger.purchaseCount} total`}
            >
              {snapshot.money.in.length === 0 ? (
                <Empty>
                  nothing yet. An outside agent gets a 402 here, pays, and this fills —
                  <br />
                  <span className="font-mono text-zinc-500">node scripts/pay.mjs /api/intel</span>
                </Empty>
              ) : (
                <ul className="space-y-1.5">
                  {snapshot.money.in.map((row) => (
                    <li
                      key={row.id}
                      className={`rounded border border-emerald-400/20 bg-emerald-400/[0.04] p-2 ${
                        newPurchases.has(row.id) ? "omon-new" : ""
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-sm font-semibold tabular-nums text-emerald-300">
                          +{row.amount} {row.token}
                        </span>
                        <span className="font-mono text-[9px] text-zinc-600">
                          {ago(row.createdAt, now)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[9px] text-zinc-500">
                        {row.endpoint} ← {short(row.buyerAddr)}
                      </p>
                      {row.txHash ? (
                        <p className="truncate font-mono text-[9px] text-zinc-600" title={row.txHash}>
                          {short(row.txHash)}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>

      {/* Manual handles. The scheduler drives the same run on its own. */}
      <footer className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {[
          ["Run now", "/api/cron/tick?force=1", "one full pass, immediately"],
          // Deliberately above BUDGET_MAX_TRADE_USD. The refusal is the feature.
          [
            "Try a $99 trade",
            "/api/cron/tick?sizeUsd=99",
            `over the ${usd(limits.maxTradeUsd)} per-trade cap — watch it get refused`,
          ],
        ].map(([label, url, title]) => (
          <button
            key={label}
            title={title}
            onClick={() => run(label, url)}
            disabled={busy !== null}
            className="rounded-md border border-white/[0.09] bg-white/[0.04] px-2.5 py-1.5 font-medium text-zinc-300 transition hover:bg-white/[0.09] disabled:opacity-40"
          >
            {busy === label ? `${label}…` : label}
          </button>
        ))}
        {note ? <span className="truncate text-zinc-500">{note}</span> : null}

        {/* Whether any of this survives a restart. Learned the hard way. */}
        <span
          className={`ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 ${
            storage.persisting
              ? "border-white/[0.07] bg-white/[0.03] text-zinc-500"
              : "border-amber-400/30 bg-amber-400/[0.06] text-amber-200"
          }`}
          title={
            storage.persisting
              ? `history is written to ${storage.dir} as it happens and read back on restart`
              : `nothing is being written to disk — ${storage.error ?? "unknown reason"}`
          }
        >
          <span
            className={`h-1 w-1 rounded-full ${storage.persisting ? "bg-emerald-400" : "bg-amber-400"}`}
            aria-hidden
          />
          {storage.persisting ? (
            <>
              saved
              <span className="font-mono text-[9px] text-zinc-600">
                {ledger.fillCount} fill{ledger.fillCount === 1 ? "" : "s"} ·{" "}
                {ledger.actionCount} action{ledger.actionCount === 1 ? "" : "s"} on disk
              </span>
            </>
          ) : (
            <>NOT SAVED — a restart will erase this</>
          )}
        </span>

        <span className="font-mono text-[9px] text-zinc-700">
          {snapshot.service.name} · {payment.rail} rail · updated {ago(snapshot.at, now)} ago
        </span>
      </footer>
    </main>
  );
}
