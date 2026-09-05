/**
 * The console. One screen, and the only thing anyone actually looks at.
 *
 * It answers three questions in the order a stranger asks them:
 *
 *   1. Is this real?      — the status row, one honest pill per seam.
 *   2. What is it doing?  — intel in, signals out, down the left.
 *   3. Does it make money and is it safe? — money in and money out, right,
 *                                           with the budget layer's verdicts.
 *
 * The one moment that matters is a payment landing. That is why the revenue
 * figure is the largest thing on the page and why a new purchase row flashes:
 * everyone at this hackathon built an agent that spends money, and the thing
 * worth seeing here is one that gets paid.
 *
 * Data is one full snapshot per beat over SSE from /api/stream. There is no
 * client-side state to drift — every number on screen came from the server
 * within the last two seconds, and the connection pill says so when it did not.
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

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function Pill({ label, mode, reason }: { label: string; mode: string; reason: string }) {
  const live = mode === "live" || mode === "in use";
  return (
    <div
      title={reason}
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : "bg-amber-400"}`}
        aria-hidden
      />
      <span className="text-[11px] font-medium tracking-wide text-zinc-300">{label}</span>
      <span className={`text-[11px] ${live ? "text-emerald-300" : "text-amber-300"}`}>{mode}</span>
    </div>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-white/10 bg-zinc-950/60">
      <header className="flex items-baseline justify-between border-b border-white/10 px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          {title}
        </h2>
        {note ? <span className="font-mono text-[10px] text-zinc-600">{note}</span> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-xs text-zinc-600">{children}</p>;
}

export default function Console() {
  const { snapshot, connection } = useSnapshot();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const newPurchases = useNewRows((snapshot?.money.in ?? []).map((p) => p.id));
  const newActions = useNewRows((snapshot?.money.out ?? []).map((a) => a.id));

  const run = useCallback(async (label: string, url: string) => {
    setBusy(label);
    setNote(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = (await res.json()) as Record<string, unknown>;
      setNote(
        typeof body.skipped === "string" && body.skipped
          ? `${label}: ${body.skipped}`
          : `${label}: done`,
      );
    } catch (err) {
      setNote(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  if (!snapshot) {
    return (
      <main className="flex flex-1 items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        connecting to /api/stream…
      </main>
    );
  }

  const { seams, ledger, limits, payment } = snapshot;
  const spentPct = Math.min(100, (ledger.spentTodayUsd / Math.max(1, limits.dailyTradeUsd)) * 100);
  const quote = snapshot.balances?.USDT ?? null;

  return (
    <main className="flex flex-1 flex-col gap-3 bg-zinc-950 p-4 text-zinc-100">
      <style>{`@keyframes omon-flash {
        0% { background-color: rgb(16 185 129 / 0.28); }
        100% { background-color: transparent; }
      }
      .omon-new { animation: omon-flash 2.4s ease-out; }`}</style>

      {/* Header: what this is, and whether every seam behind it is real. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{snapshot.service.name}</h1>
          <p className="hidden max-w-md text-xs text-zinc-500 sm:block">
            {snapshot.service.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill label="Intel" mode={seams.intelAgent.mode} reason={seams.intelAgent.reason} />
          <Pill label="Signal" mode={seams.signalAgent.mode} reason={seams.signalAgent.reason} />
          <Pill label="News" mode={seams.news.mode} reason={seams.news.reason} />
          <Pill label="Exchange" mode={seams.exchange.mode} reason={seams.exchange.reason} />
          <Pill label="MCP" mode={seams.mcp.mode} reason={seams.mcp.reason} />
          <Pill label="Skill Hub" mode={seams.skillHub.mode} reason={seams.skillHub.reason} />
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connection === "live" ? "animate-pulse bg-emerald-400" : "bg-amber-400"
              }`}
              aria-hidden
            />
            <span className="text-[11px] text-zinc-400">{connection}</span>
          </div>
        </div>
      </header>

      {/* The money row. Revenue is the biggest number on the page on purpose. */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-5 py-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-emerald-300/70">
            Paid to Omon · 24h
          </p>
          <p className="mt-1 font-mono text-4xl font-semibold tabular-nums text-emerald-300">
            {usd(ledger.earnedTodayUsd)}
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {ledger.purchaseCount} purchase{ledger.purchaseCount === 1 ? "" : "s"} · x402 ·{" "}
            {payment.token} on {payment.network} · {payment.price} each
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-zinc-950/60 px-5 py-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            Traded · 24h (Spot Demo Mode)
          </p>
          <p className="mt-1 font-mono text-4xl font-semibold tabular-nums">
            {usd(ledger.spentTodayUsd)}
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {ledger.orderCount} order{ledger.orderCount === 1 ? "" : "s"} · {ledger.blockedCount}{" "}
            refused by the budget layer
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-zinc-950/60 px-5 py-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            Demo account balance
          </p>
          <p className="mt-1 font-mono text-4xl font-semibold tabular-nums">
            {quote === null ? "—" : `${Number(quote).toFixed(2)}`}
            <span className="ml-1.5 text-base font-normal text-zinc-500">USDT</span>
          </p>
          <p
            className="mt-1 truncate text-[11px] text-zinc-500"
            title={snapshot.balancesError ?? ""}
          >
            {snapshot.balancesError
              ? `stale — ${snapshot.balancesError}`
              : "the account orders actually hit"}
          </p>
        </div>
      </section>

      {/* The leash, drawn. Never a bare number — the cap is the claim. */}
      <section className="rounded-xl border border-white/10 bg-zinc-950/60 px-5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]">
          <span className="uppercase tracking-[0.14em] text-zinc-500">Budget layer</span>
          <span className="font-mono text-zinc-400">
            {usd(ledger.spentTodayUsd)} of {usd(limits.dailyTradeUsd)} daily ·{" "}
            {usd(limits.maxTradeUsd)} per trade · {limits.allowedSymbols.join(" ")}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-emerald-400 transition-all duration-700"
            style={{ width: `${spentPct}%` }}
          />
        </div>
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Left: what the Intel Agent made of the news. */}
        <Panel
          title="Intel"
          note={
            snapshot.intel.source === "fixture"
              ? "fixture — cache cold"
              : `${snapshot.intel.status.rows} rows · ${snapshot.intel.status.fresh ? "fresh" : "stale"}`
          }
        >
          {snapshot.intel.rows.length === 0 ? (
            <Empty>no intel yet — run a tick</Empty>
          ) : (
            <ul className="space-y-2.5">
              {snapshot.intel.rows.map((row) => (
                <li key={row.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider ${
                        row.direction === "bullish"
                          ? "text-emerald-400"
                          : row.direction === "bearish"
                            ? "text-rose-400"
                            : "text-zinc-400"
                      }`}
                    >
                      {row.direction} · {Math.round(row.confidence * 100)}%
                    </span>
                    <span className="font-mono text-[10px] text-zinc-600">
                      {ago(row.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-medium leading-snug text-zinc-200">
                    {row.headline}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{row.summary}</p>
                  <p className="mt-1.5 font-mono text-[10px] text-zinc-600">
                    {row.assets.join(" ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Middle: what the Signal Agent decided to do about it. */}
        <Panel
          title="Signals"
          note={
            snapshot.signals.source === "empty"
              ? "cache empty"
              : `${snapshot.signals.status.rows} rows · ${snapshot.signals.status.fresh ? "fresh" : "stale"}`
          }
        >
          {snapshot.signals.rows.length === 0 ? (
            <Empty>
              {snapshot.signals.status.lastError ?? "no signal yet — intel has to land first"}
            </Empty>
          ) : (
            <ul className="space-y-2.5">
              {snapshot.signals.rows.map((row) => (
                <li key={row.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold">
                      <span className={row.side === "BUY" ? "text-emerald-400" : "text-rose-400"}>
                        {row.side}
                      </span>{" "}
                      {row.symbol} · {usd(row.sizeUsd)}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-600">
                      {ago(row.createdAt)}
                    </span>
                  </div>
                  {row.convictionLabel ? (
                    <p className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">
                      conviction {row.convictionLabel}
                      {typeof row.convictionScore === "number"
                        ? ` · ${row.convictionScore.toFixed(2)}`
                        : ""}
                      {row.aligned === false ? " · news and chart disagree" : ""}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{row.thesis}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Right: the money, both directions. */}
        <div className="grid min-h-0 grid-rows-2 gap-3">
          <Panel title="Money in — agents paying Omon" note={`${ledger.purchaseCount} total`}>
            {snapshot.money.in.length === 0 ? (
              <Empty>no purchases yet — run scripts/pay.mjs</Empty>
            ) : (
              <ul className="space-y-1.5">
                {snapshot.money.in.map((row) => (
                  <li
                    key={row.id}
                    className={`rounded-lg border border-emerald-400/20 p-2.5 ${
                      newPurchases.has(row.id) ? "omon-new" : ""
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-emerald-300">
                        +{row.amount} {row.token}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-600">
                        {ago(row.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                      {row.endpoint} · {short(row.buyerAddr)}
                    </p>
                    {row.txHash ? (
                      <p
                        className="truncate font-mono text-[10px] text-zinc-600"
                        title={row.txHash}
                      >
                        {short(row.txHash)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Money out — trades and refusals" note={`${ledger.actionCount} total`}>
            {snapshot.money.out.length === 0 ? (
              <Empty>no trades yet — run a tick</Empty>
            ) : (
              <ul className="space-y-1.5">
                {snapshot.money.out.map((row) => {
                  const allowed = row.decision === "ALLOW" && row.orderId !== null;
                  return (
                    <li
                      key={row.id}
                      className={`rounded-lg border p-2.5 ${
                        allowed ? "border-white/10" : "border-rose-400/30 bg-rose-400/[0.04]"
                      } ${newActions.has(row.id) ? "omon-new" : ""}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-xs font-semibold">
                          {String(row.payload.side ?? "")} {String(row.payload.symbol ?? "")} ·{" "}
                          {usd(Number(row.payload.sizeUsd ?? 0))}
                        </span>
                        <span
                          className={`text-[10px] font-semibold uppercase tracking-wider ${
                            allowed ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {allowed ? "filled" : row.decision.toLowerCase()}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">
                        {row.reason}
                      </p>
                      <p className="font-mono text-[10px] text-zinc-600">
                        {row.orderId ? `order ${row.orderId} · ` : ""}
                        {ago(row.createdAt)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/* Demo drivers. The tick normally runs on an interval; these are for the film. */}
      <footer className="flex flex-wrap items-center gap-2 text-[11px]">
        {[
          ["Refresh intel", "/api/intel/refresh?force=1"],
          ["Run tick", "/api/cron/tick"],
          // Deliberately above BUDGET_MAX_TRADE_USD. The refusal is the feature.
          ["Trade $99 (blocked)", "/api/cron/tick?sizeUsd=99"],
        ].map(([label, url]) => (
          <button
            key={label}
            onClick={() => run(label, url)}
            disabled={busy !== null}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-medium text-zinc-300 transition hover:bg-white/10 disabled:opacity-40"
          >
            {busy === label ? `${label}…` : label}
          </button>
        ))}
        {note ? <span className="text-zinc-500">{note}</span> : null}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          reads:{" "}
          {Object.entries(snapshot.usage)
            .map(([k, v]) => `${k}→${v.via}`)
            .join("  ") || "none yet"}
        </span>
      </footer>
    </main>
  );
}
