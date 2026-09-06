/**
 * The console. One screen, and the only thing anyone actually looks at.
 *
 * It answers four questions in the order a stranger asks them:
 *
 *   1. Is it making money?  the P&L headline, split by venue.
 *   2. Is it alive?         the heartbeat, the countdown, the moving marks.
 *   3. What is it doing?    one pane at a time, chosen by the reader.
 *   4. Is it safe?          the daily cap, drawn, and every refusal kept.
 *
 * ## Why this is tabbed now
 *
 * The previous version put six panels on screen at once in a three column grid,
 * at 9 and 10 pixel type. Two things went wrong with it and both were structural
 * rather than cosmetic:
 *
 *   - **Nothing was legible.** Six panels competing for one viewport means every
 *     one of them is too small, and the P&L, which is the entire point, was the
 *     same size as the news feed.
 *   - **Every list grew the page.** The panels were plain lists, so a busy hour
 *     pushed the footer, and then the profit figure, off the bottom of the
 *     screen. The screen got worse the better the agent did.
 *
 * So: the numbers that answer "did it work" are always on screen, and the detail
 * behind them lives in one pane the reader picks. Each pane is a fixed viewport
 * that scrolls inside itself, so the layout is the same on beat 1 and beat 400.
 *
 * ## Plain language is a feature here, not a nicety
 *
 * The vocabulary of the people who built this ("seam", "beat", "rail") is gone
 * from the interface. Every number carries a sentence saying what it is. The
 * engineering detail did not get deleted, it got moved behind "System", which is
 * where someone goes when they want it rather than something everyone reads past.
 *
 * Data is one full snapshot per beat over SSE from /api/stream. There is no
 * client side state to drift: every number came from the server within the last
 * two seconds, and the connection pill says so when it did not.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleSnapshot } from "@/lib/console-state";
import {
  AnimatedNumber,
  Bar,
  Card,
  Empty,
  Pill,
  Row,
  ScrollList,
  Skeleton,
  Stat,
  StatusDot,
  ago,
  mark,
  plain,
  moneyTone,
  qty,
  short,
  signedPct,
  signedUsd,
  usd,
} from "@/components/ui";

type Connection = "connecting" | "live" | "reconnecting";
type Tab = "reasoning" | "positions" | "activity" | "intel" | "revenue";

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

    // EventSource reconnects by itself. The pill exists so a stalled feed during
    // a recording is visible rather than looking like a system that went quiet.
    source.onerror = () => setConnection("reconnecting");

    return () => source.close();
  }, []);

  return { snapshot, connection };
}

/**
 * A clock that ticks locally between snapshots.
 *
 * The countdown has to move every second but snapshots arrive every two, so it
 * is computed from the server's `nextAt` against a local clock rather than being
 * pushed. Drift is bounded by the next snapshot correcting it.
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
  const key = ids.join("|");

  useEffect(() => {
    // The first beat is not "new". Everything would flash at once on load.
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
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return fresh;
}

function countdown(iso: string | null, now: number): string {
  if (!iso) return "soon";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

/* ========================================================================== */

export default function Console() {
  const { snapshot, connection } = useSnapshot();
  const now = useNow();
  // Opens on the reasoning trace, not the positions table. The hero already
  // answers "did it make money" without a click, so the pane below is free to
  // answer the more interesting question, which is how it decided.
  const [tab, setTab] = useState<Tab>("reasoning");
  const [systemOpen, setSystemOpen] = useState(false);

  const newActions = useNewRows((snapshot?.money.out ?? []).map((a) => a.id));
  const newPurchases = useNewRows((snapshot?.money.in ?? []).map((p) => p.id));

  const counts = useMemo(
    () => ({
      positions: (snapshot?.pnl.spot.openCount ?? 0) + (snapshot?.pnl.futures.openCount ?? 0),
      activity: snapshot?.money.out.length ?? 0,
      intel: snapshot?.intel.rows.length ?? 0,
      revenue: snapshot?.money.in.length ?? 0,
    }),
    [snapshot],
  );

  if (!snapshot) {
    return (
      <main className="grid-bg flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-md">
          <p className="eyebrow mb-3">Omon</p>
          <p className="mb-6 text-sm text-muted">
            Connecting to the live feed. This takes about a second.
          </p>
          <Card>
            <Skeleton rows={3} />
          </Card>
        </div>
      </main>
    );
  }

  const { pnl, ledger, scheduler, seams, payment, storage } = snapshot;
  const totalPnl = pnl.totalUsd;

  return (
    <div className="grid-bg min-h-screen">
      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-20 border-b border-edge bg-void/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5 sm:px-8">
          <h1 className="text-lg font-semibold tracking-tight text-ink">Omon</h1>

          <p className="hidden text-sm text-muted lg:block">
            An AI agent that sells market intelligence, and trades on what it knows.
          </p>

          <div className="ml-auto flex items-center gap-2.5">
            <Pill tone={connection === "live" ? "up" : "warn"} title={`Feed is ${connection}`}>
              <StatusDot tone={connection === "live" ? "up" : "warn"} />
              {connection === "live" ? "Live" : "Reconnecting"}
            </Pill>

            <Pill tone="neutral" title="The agent runs a full cycle on its own, on this timer.">
              Next run {countdown(scheduler.nextAt, now)}
            </Pill>

            <button
              onClick={() => setSystemOpen((open) => !open)}
              aria-expanded={systemOpen}
              className="rounded-md border border-edge2 bg-elev px-2.5 py-1 text-xs font-semibold text-muted transition hover:border-brand/40 hover:text-ink"
            >
              System {systemOpen ? "▲" : "▼"}
            </button>
          </div>
        </div>

        {systemOpen ? <SystemPanel snapshot={snapshot} /> : null}
      </header>

      <main className="mx-auto max-w-7xl space-y-7 px-5 py-7 sm:px-8">
        {/* ---------- hero: the question everyone actually has ---------- */}
        <section aria-labelledby="profit-heading">
          <h2 id="profit-heading" className="eyebrow">
            Trading profit
          </h2>

          <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">
            <AnimatedNumber
              value={totalPnl}
              prefix="$"
              className={`text-5xl font-semibold leading-none ${moneyTone(totalPnl)}`}
            />
            {pnl.spot.totalPct !== null ? (
              <span className={`text-lg font-medium ${moneyTone(totalPnl)}`}>
                {signedPct(pnl.spot.totalPct)}
              </span>
            ) : null}
          </div>

          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Everything Omon has made or lost across both venues, priced at the live marks below.
            Spot and futures are counted separately because they are different trades, and one
            combined figure would hide which half is working.
          </p>

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Spot"
              delay={0}
              tone={moneyTone(pnl.spot.totalUsd)}
              value={signedUsd(pnl.spot.totalUsd)}
              sub={
                pnl.spot.openCount > 0
                  ? `${pnl.spot.openCount} position${pnl.spot.openCount === 1 ? "" : "s"} open, worth ${usd(pnl.spot.marketValueUsd)}`
                  : "Buying and selling coins outright. Nothing open."
              }
            />

            <Stat
              label="Futures"
              delay={60}
              tone={
                seams.futures.mode === "off" ? "text-muted" : moneyTone(pnl.futures.totalUsd)
              }
              value={seams.futures.mode === "off" ? "Off" : signedUsd(pnl.futures.totalUsd)}
              sub={
                seams.futures.mode === "off"
                  ? "Leveraged longs and shorts. Switched off on this build."
                  : pnl.futures.openCount > 0
                    ? `${pnl.futures.longCount} long, ${pnl.futures.shortCount} short, ${usd(pnl.futures.marginUsd)} of margin at risk`
                    : `Leveraged longs and shorts, up to ${snapshot.maxLeverage}x. Nothing open.`
              }
            />

            <Stat
              label="Earned from data"
              delay={120}
              tone={ledger.earnedTodayUsd > 0 ? "text-up" : "text-ink"}
              value={`$${ledger.earnedTodayUsd.toFixed(2)}`}
              sub={`Other agents paying for Omon's analysis over ${payment.rail}. A separate rail from trading, so it is never netted in.`}
            />

            <Card hover className="rise px-4 py-3.5" >
              <div style={{ animationDelay: "180ms" }}>
                <p className="eyebrow">Left to spend today</p>
                <p className="mt-2 text-lg font-semibold leading-none text-ink">
                  {usd(ledger.remainingTodayUsd)}
                </p>
                <Bar used={ledger.spentTodayUsd} total={ledger.dailyTradeUsd} />
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {usd(ledger.spentTodayUsd)} of {usd(ledger.dailyTradeUsd)} used. Closing a
                  position never counts against it.
                </p>
              </div>
            </Card>
          </div>
        </section>

        {/* ---------- what it did last ---------- */}
        <LastRun snapshot={snapshot} now={now} />

        {/* ---------- tabs ---------- */}
        <section>
          <div role="tablist" aria-label="Console views" className="flex flex-wrap gap-1.5">
            {(
              [
                ["reasoning", "Reasoning", 0],
                ["intel", "Intelligence", counts.intel],
                ["positions", "Positions", counts.positions],
                ["activity", "Orders", counts.activity],
                ["revenue", "Revenue", counts.revenue],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-lg border px-3.5 py-2 text-sm font-medium transition ${
                  tab === id
                    ? "border-brand/40 bg-brand/10 text-brand"
                    : "border-edge bg-panel text-muted hover:border-edge2 hover:text-ink2"
                }`}
              >
                {label}
                {count > 0 ? (
                  <span className="ml-2 rounded bg-elev px-1.5 py-0.5 text-xs tabular-nums text-muted">
                    {count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* One fixed viewport. Panes scroll inside it, they never grow it. */}
          <Card className="mt-3 flex h-[460px] flex-col overflow-hidden">
            {tab === "reasoning" ? <ReasoningPane snapshot={snapshot} now={now} /> : null}
            {tab === "intel" ? <IntelligencePane snapshot={snapshot} now={now} /> : null}
            {tab === "positions" ? <PositionsPane snapshot={snapshot} /> : null}
            {tab === "activity" ? (
              <ActivityPane snapshot={snapshot} now={now} fresh={newActions} />
            ) : null}
            {tab === "revenue" ? (
              <RevenuePane snapshot={snapshot} now={now} fresh={newPurchases} />
            ) : null}
          </Card>
        </section>

        {/* ---------- footer ----------
         * Whether any of this survives a restart, and nothing else.
         *
         * The manual "run a cycle" and "try a $99 trade" buttons used to live
         * here. They were removed: the scheduler drives the identical cycle on
         * its own every five minutes, so they demonstrated nothing the page was
         * not already showing, and two buttons under the fold read as a control
         * panel on a screen whose whole claim is that it runs unattended.
         * POST /api/cron/tick still does both, for a terminal.
         */}
        <footer className="flex flex-wrap items-center gap-2.5 pb-4">
          <span
            className="flex items-center gap-2 text-xs text-faint"
            title={
              storage.persisting
                ? `History is written to ${storage.dir} as it happens, and read back on restart.`
                : `Nothing is reaching the disk. ${storage.error ?? "Reason unknown."}`
            }
          >
            <StatusDot tone={storage.persisting ? "up" : "warn"} pulse={false} />
            {storage.persisting
              ? `Saved. ${ledger.fillCount} fill${ledger.fillCount === 1 ? "" : "s"} on disk.`
              : "Not saved. A restart will erase this."}
          </span>
        </footer>
      </main>
    </div>
  );
}

/* ========================================================================== */

/**
 * What happened on the most recent cycle, in one sentence.
 *
 * On screen at all times, above the tabs, because a viewer who is on the wrong
 * pane when something happens would otherwise see nothing move. During a
 * recording this line is the proof the agent is running unattended.
 */
function LastRun({ snapshot, now }: { snapshot: ConsoleSnapshot; now: number }) {
  const tick = snapshot.lastTick;
  if (!tick) {
    return (
      <Card className="px-4 py-3">
        <p className="text-sm text-muted">
          Waiting for the first cycle. It runs on its own, or press Run a cycle now.
        </p>
      </Card>
    );
  }

  const signal = tick.signal;
  const verdict = tick.decision;
  const tone = tick.order ? "up" : verdict && verdict.decision !== "ALLOW" ? "down" : "neutral";

  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <Pill tone={tone}>
        {tick.order ? "Order placed" : verdict && verdict.decision !== "ALLOW" ? "Refused" : "No trade"}
      </Pill>

      <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink2">
        {tick.skipped
          ? plain(tick.skipped)
          : signal
            ? `${signal.side} ${signal.symbol} for ${usd(signal.sizeUsd)}${
                signal.venue === "futures" ? ` on futures at ${signal.leverage ?? 1}x` : " on spot"
              }. ${plain(verdict?.reason ?? "")}`
            : "Nothing to act on this cycle."}
      </p>

      <span className="text-xs whitespace-nowrap text-faint">
        {tick.source === "schedule" ? "Automatic" : "Manual"}, {ago(tick.at, now)}
      </span>
    </Card>
  );
}

/* ---------- positions ---------- */

function PaneHeader({
  title,
  help,
  right,
}: {
  title: string;
  help: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-edge px-4 py-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{help}</p>
      </div>
      {right}
    </header>
  );
}

function PositionsPane({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const { spot, futures } = snapshot.pnl;
  const futuresOff = snapshot.seams.futures.mode === "off";

  return (
    <div className="grid min-h-0 flex-1 grid-rows-2 divide-y divide-edge lg:grid-cols-2 lg:grid-rows-1 lg:divide-x lg:divide-y-0">
      {/* Spot */}
      <div className="flex min-h-0 flex-col">
        <PaneHeader
          title="Spot"
          help="Coins bought and held outright. Profit is the live price against what Omon paid."
          right={
            <span className={`num text-sm font-semibold ${moneyTone(spot.totalUsd)}`}>
              {signedUsd(spot.totalUsd)}
            </span>
          }
        />
        {spot.positions.length === 0 ? (
          <Empty>
            Nothing bought yet. A cycle that gets past the spending limits buys here, and the
            profit on it shows up in this pane and in the headline above.
          </Empty>
        ) : (
          <ScrollList>
            {spot.positions.map((row, i) => {
              const open = row.qty > 0;
              const shown = open ? row.unrealizedUsd : row.realizedUsd;
              const asset = row.symbol.replace("USDT", "");
              return (
                <Row key={row.symbol} index={i}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-ink">
                      {asset}
                      <span className="ml-2 text-xs font-normal text-faint">
                        {open ? "held" : "sold"}
                      </span>
                    </span>
                    <span className={`num text-sm font-semibold ${moneyTone(shown)}`}>
                      {signedUsd(shown)}
                      {open && row.unrealizedPct !== null ? (
                        <span className="ml-1.5 text-xs font-normal">
                          {signedPct(row.unrealizedPct)}
                        </span>
                      ) : null}
                    </span>
                  </div>

                  {open ? (
                    <p className="num mt-1.5 text-xs leading-relaxed text-muted">
                      {qty(row.qty)} {asset} bought at {mark(row.avgCostUsd)}
                      {row.markPrice !== null ? `, now ${mark(row.markPrice)}` : ", not priced"}
                    </p>
                  ) : (
                    <p className="num mt-1.5 text-xs text-muted">
                      Fully sold. {signedUsd(row.realizedUsd)} booked.
                    </p>
                  )}

                  {open && Math.abs(row.realizedUsd) >= 0.005 ? (
                    <p className="num mt-0.5 text-xs text-faint">
                      Plus {signedUsd(row.realizedUsd)} already booked on earlier sells.
                    </p>
                  ) : null}
                </Row>
              );
            })}
          </ScrollList>
        )}

        {Object.keys(spot.unbasedSells).length > 0 ? (
          <p className="mx-4 mb-4 rounded-lg border border-warn/25 bg-warn/[0.06] px-3 py-2 text-xs leading-relaxed text-warn">
            Some of what was sold was already in the demo account before Omon started, so it has
            no cost here and earns no profit here. These figures cover Omon&apos;s own trades only.
          </p>
        ) : null}
      </div>

      {/* Futures */}
      <div className="flex min-h-0 flex-col">
        <PaneHeader
          title="Futures"
          help="Leveraged positions that can be long or short. A short makes money when the price falls."
          right={
            <span
              className={`num text-sm font-semibold ${futuresOff ? "text-muted" : moneyTone(futures.totalUsd)}`}
            >
              {futuresOff ? "Off" : signedUsd(futures.totalUsd)}
            </span>
          }
        />

        {futuresOff ? (
          <Empty>
            Futures is switched off on this build. Turning it on lets Omon act on a bearish read
            by going short, which a spot account cannot do at all.
          </Empty>
        ) : futures.positions.length === 0 ? (
          <Empty>
            No leveraged positions yet. When the news and the chart both point down, Omon opens a
            short here instead of sitting the move out.
          </Empty>
        ) : (
          <ScrollList>
            {futures.positions.map((row, i) => {
              const open = row.qty !== 0;
              const shown = open ? row.unrealizedUsd : row.realizedUsd;
              const asset = row.symbol.replace("USDT", "");
              return (
                <Row key={row.symbol} index={i}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                      {asset}
                      {open ? (
                        <Pill tone={row.direction === "long" ? "up" : "down"}>
                          {row.direction} {row.leverage}x
                        </Pill>
                      ) : (
                        <span className="text-xs font-normal text-faint">closed</span>
                      )}
                    </span>
                    <span className={`num text-sm font-semibold ${moneyTone(shown)}`}>
                      {signedUsd(shown)}
                      {open && row.returnOnMarginPct !== null ? (
                        <span className="ml-1.5 text-xs font-normal">
                          {signedPct(row.returnOnMarginPct)}
                        </span>
                      ) : null}
                    </span>
                  </div>

                  {open ? (
                    <>
                      <p className="num mt-1.5 text-xs leading-relaxed text-muted">
                        {qty(row.qty)} {asset} from {mark(row.entryPrice)}
                        {row.markPrice !== null ? `, now ${mark(row.markPrice)}` : ", not priced"}
                      </p>
                      <p className="num mt-0.5 text-xs text-faint">
                        {usd(row.notionalUsd)} of exposure on {usd(row.marginUsd)} of margin.
                        {row.returnOnMarginPct !== null && row.unrealizedPct !== null
                          ? ` ${signedPct(row.unrealizedPct)} on the price move.`
                          : ""}
                      </p>
                    </>
                  ) : (
                    <p className="num mt-1.5 text-xs text-muted">
                      Closed. {signedUsd(row.realizedUsd)} booked.
                    </p>
                  )}
                </Row>
              );
            })}
          </ScrollList>
        )}
      </div>
    </div>
  );
}

/* ---------- orders ---------- */

function ActivityPane({
  snapshot,
  now,
  fresh,
}: {
  snapshot: ConsoleSnapshot;
  now: number;
  fresh: Set<string>;
}) {
  const rows = snapshot.money.out;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title="Orders placed and refused"
        help="Every trade the agent proposed and the verdict the spending limits gave it. Red rows never reached the exchange."
        right={
          <span className="whitespace-nowrap text-xs text-muted">
            {snapshot.ledger.orderCount} placed, {snapshot.ledger.blockedCount} refused
          </span>
        }
      />

      {rows.length === 0 ? (
        <Empty>
          No orders yet. The next cycle decides, or press Try a $99 trade to watch the spending
          limits refuse one.
        </Empty>
      ) : (
        <ScrollList>
          {rows.map((row, i) => {
            const filled = row.decision === "ALLOW" && row.orderId !== null;
            const venue = row.payload.venue === "futures" ? "futures" : "spot";
            const leverage = Number(row.payload.leverage ?? 1);
            return (
              <Row
                key={row.id}
                index={i}
                fresh={fresh.has(row.id)}
                tone={filled ? "neutral" : "down"}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className={row.payload.side === "SELL" ? "text-down" : "text-up"}>
                      {String(row.payload.side ?? "")}
                    </span>
                    {String(row.payload.symbol ?? "")}
                    <span className="num font-normal text-muted">
                      {usd(Number(row.payload.sizeUsd ?? 0))}
                    </span>
                    {venue === "futures" ? (
                      <Pill tone="neutral">
                        futures {leverage > 1 ? `${leverage}x` : ""}
                      </Pill>
                    ) : null}
                  </span>
                  <span
                    className={`text-xs font-semibold ${filled ? "text-up" : "text-down"}`}
                  >
                    {filled ? "Placed" : "Refused"}
                  </span>
                </div>

                <p className="mt-1.5 text-xs leading-relaxed text-muted">{plain(row.reason)}</p>
                <p className="num mt-0.5 text-xs text-faint">
                  {row.orderId ? `Order ${row.orderId}, ` : ""}
                  {ago(row.createdAt, now)}
                </p>
              </Row>
            );
          })}
        </ScrollList>
      )}
    </div>
  );
}

/* ---------- ideas ---------- */

/**
 * The two agents' output, and the only pane with a brand-coloured banner on it.
 *
 * That banner is not decoration. This pane is the actual merchandise: both
 * columns are what an outside agent pays a 402 to read, and without saying so
 * the screen reads as if the analysis exists to serve the trading. It is the
 * other way round. The trading is Omon eating its own cooking, and the thing
 * being sold is right here.
 */
function IntelligencePane({ snapshot, now }: { snapshot: ConsoleSnapshot; now: number }) {
  const intel = snapshot.intel.rows;
  const signals = snapshot.signals.rows;
  const { payment } = snapshot;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-brand/25 bg-brand/[0.07] px-4 py-2.5">
        <span className="text-sm font-semibold text-brand">Omon sells this</span>
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink2">
          Both columns are for sale to other agents over {payment.rail}. {payment.price}{" "}
          {payment.token} a call, no account and no API key.
        </p>
        <span className="num whitespace-nowrap text-xs text-faint">/api/intel, /api/signals</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-2 divide-y divide-edge lg:grid-cols-2 lg:grid-rows-1 lg:divide-x lg:divide-y-0">
      <div className="flex min-h-0 flex-col">
        <PaneHeader
          title="Intel Agent"
          help="Headlines read and scored: which way each story points, and how sure the model is. Sold as /api/intel."
        />
        {intel.length === 0 ? (
          <Empty>
            {plain(snapshot.intel.status.lastError ?? "No news read yet. The next cycle fetches it.")}
          </Empty>
        ) : (
          <ScrollList>
            {intel.map((row, i) => (
              <Row key={row.id} index={i}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium leading-snug text-ink">{plain(row.headline)}</p>
                  <Pill
                    tone={
                      row.direction === "bullish"
                        ? "up"
                        : row.direction === "bearish"
                          ? "down"
                          : "neutral"
                    }
                    title="Which way this story points, and how sure the model is."
                  >
                    {row.direction} {Math.round(row.confidence * 100)}%
                  </Pill>
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted">
                  {plain(row.summary)}
                </p>
                <p className="mt-1 text-xs text-faint">{ago(row.createdAt, now)}</p>
              </Row>
            ))}
          </ScrollList>
        )}
      </div>

      <div className="flex min-h-0 flex-col">
        <PaneHeader
          title="Signal Agent"
          help="The news blended with the chart into one trade idea. Proposals only, nothing here has been placed. Sold as /api/signals."
        />
        {signals.length === 0 ? (
          <Empty>
            {plain(snapshot.signals.status.lastError ?? "No idea yet. The news gets read first.")}
          </Empty>
        ) : (
          <ScrollList>
            {signals.map((row, i) => (
              <Row key={row.id} index={i}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className={row.side === "SELL" ? "text-down" : "text-up"}>
                      {row.side}
                    </span>
                    {row.symbol}
                    <span className="num font-normal text-muted">{usd(row.sizeUsd)}</span>
                  </span>
                  <span className="text-xs whitespace-nowrap text-faint">
                    {ago(row.createdAt, now)}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Pill tone={row.venue === "futures" ? "brand" : "neutral"}>
                    {row.venue === "futures"
                      ? `futures ${row.leverage ?? 1}x`
                      : "spot"}
                  </Pill>
                  {row.convictionLabel ? (
                    <Pill
                      tone={
                        row.convictionLabel === "high"
                          ? "up"
                          : row.convictionLabel === "medium"
                            ? "warn"
                            : "neutral"
                      }
                      title="How strongly the news and the chart agreed."
                    >
                      {row.convictionLabel} conviction
                    </Pill>
                  ) : null}
                  {row.aligned === false ? (
                    <span className="text-xs text-faint">news and chart disagree</span>
                  ) : null}
                </div>

                <p className="mt-2 text-xs leading-relaxed text-muted">{plain(row.thesis)}</p>
              </Row>
            ))}
          </ScrollList>
        )}
        </div>
      </div>
    </div>
  );
}

/* ---------- revenue ---------- */

function RevenuePane({
  snapshot,
  now,
  fresh,
}: {
  snapshot: ConsoleSnapshot;
  now: number;
  fresh: Set<string>;
}) {
  const rows = snapshot.money.in;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title="Paid to Omon"
        help="Outside agents buying Omon's analysis. This is revenue, and it is kept apart from trading profit because it settles on a different rail."
        right={
          <span className="whitespace-nowrap text-xs text-muted">
            {snapshot.ledger.purchaseCount} total
          </span>
        }
      />

      {rows.length === 0 ? (
        <Empty>
          Nothing yet. An outside agent asks for the data, gets a real 402 Payment Required, pays
          in {snapshot.payment.token}, and lands here.
        </Empty>
      ) : (
        <ScrollList>
          {rows.map((row, i) => (
            <Row key={row.id} index={i} fresh={fresh.has(row.id)} tone="up">
              <div className="flex items-baseline justify-between gap-3">
                <span className="num text-sm font-semibold text-up">
                  +{row.amount} {row.token}
                </span>
                <span className="text-xs whitespace-nowrap text-faint">
                  {ago(row.createdAt, now)}
                </span>
              </div>
              <p className="num mt-1 truncate text-xs text-muted">
                {row.endpoint} bought by {short(row.buyerAddr)}
              </p>
              {row.txHash ? (
                <p className="num truncate text-xs text-faint" title={row.txHash}>
                  {short(row.txHash)}
                </p>
              ) : null}
            </Row>
          ))}
        </ScrollList>
      )}
    </div>
  );
}


/* ---------- reasoning ---------- */

/**
 * One line of the agent's reasoning, as a terminal would print it.
 *
 * `seq` orders lines that share a timestamp. Every conviction reason on a signal
 * carries that signal's `createdAt`, so without it the chart lines, the score
 * and the thesis would sort arbitrarily and the trace would read as nonsense.
 */
type TraceLine = {
  id: string;
  at: string;
  seq: number;
  kind: "INTEL" | "READ" | "CHART" | "SCORE" | "IDEA" | "THESIS" | "BUDGET" | "FILL" | "SKIP";
  text: string;
};

const KIND_TONE: Record<TraceLine["kind"], string> = {
  INTEL: "text-brand",
  READ: "text-ink2",
  CHART: "text-muted",
  SCORE: "text-brand",
  IDEA: "text-ink",
  THESIS: "text-muted",
  BUDGET: "text-ink2",
  FILL: "text-up",
  SKIP: "text-faint",
};

/**
 * Compose the reasoning trace out of the snapshot.
 *
 * Nothing here is generated for the screen. Every line is a field that already
 * existed and was already being shown somewhere less legible: the conviction
 * reasons in particular are written by `conviction()` in plain English and were
 * previously buried in a tooltip. Rendering them in order, against the clock,
 * is the difference between a page that reports an outcome and one that shows
 * the working.
 *
 * That distinction matters for a judge: "the model said BUY" is a claim, and
 * "news +0.75, chart +0.56, they agree, therefore BUY $20" is the claim with
 * its arithmetic attached.
 */
function buildTrace(snapshot: ConsoleSnapshot): TraceLine[] {
  const lines: TraceLine[] = [];

  for (const row of snapshot.intel.rows) {
    lines.push({ id: `${row.id}-h`, at: row.createdAt, seq: 0, kind: "INTEL", text: row.headline });
    lines.push({
      id: `${row.id}-r`,
      at: row.createdAt,
      seq: 1,
      kind: "READ",
      text:
        `${row.direction} at ${Math.round(row.confidence * 100)}% confidence` +
        (row.assets.length > 0 ? ` on ${row.assets.slice(0, 4).join(", ")}` : ""),
    });
  }

  for (const row of snapshot.signals.rows) {
    const reasons = row.convictionReasons ?? [];
    reasons.forEach((reason, i) => {
      lines.push({
        id: `${row.id}-c${i}`,
        at: row.createdAt,
        seq: 10 + i,
        // The agreement line is the finding the whole strategy rests on, so it
        // is called out rather than shown as one bullet among four.
        kind: reason.toLowerCase().includes("news and chart") ? "SCORE" : "CHART",
        text: reason,
      });
    });

    lines.push({
      id: `${row.id}-i`,
      at: row.createdAt,
      seq: 30,
      kind: "IDEA",
      text:
        `${row.side} ${row.symbol} ${usd(row.sizeUsd)} on ${row.venue ?? "spot"}` +
        (row.venue === "futures" ? ` at ${row.leverage ?? 1}x` : "") +
        (row.convictionLabel ? `, ${row.convictionLabel} conviction` : ""),
    });
    lines.push({ id: `${row.id}-t`, at: row.createdAt, seq: 31, kind: "THESIS", text: row.thesis });
  }

  for (const row of snapshot.money.out) {
    const filled = row.decision === "ALLOW" && row.orderId !== null;
    lines.push({
      id: `${row.id}-b`,
      at: row.createdAt,
      seq: 40,
      kind: "BUDGET",
      text: `${row.decision} ${row.reason}`,
    });
    if (filled) {
      lines.push({
        id: `${row.id}-o`,
        at: row.createdAt,
        seq: 41,
        kind: "FILL",
        text: `order ${row.orderId} placed on the exchange`,
      });
    }
  }

  if (snapshot.lastTick?.skipped) {
    lines.push({
      id: `tick-${snapshot.lastTick.at}`,
      at: snapshot.lastTick.at,
      seq: 50,
      kind: "SKIP",
      text: snapshot.lastTick.skipped,
    });
  }

  // Every line above is model or feed written, so it is cleaned once here
  // rather than at nine separate render sites. See plain().
  return lines
    .map((line) => ({ ...line, text: plain(line.text) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

/**
 * The agent thinking, as a log.
 *
 * Oldest at the top and newest at the bottom, like every terminal anyone has
 * used, and it follows the tail on its own. The follow is abandoned the moment
 * the reader scrolls up: a pane that yanks you back to the bottom while you are
 * reading is worse than one that does not move at all.
 */
function ReasoningPane({
  snapshot,
  now,
}: {
  snapshot: ConsoleSnapshot;
  now: number;
}) {
  const lines = useMemo(() => buildTrace(snapshot), [snapshot]);
  const fresh = useNewRows(lines.map((l) => l.id));
  const scroller = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);

  // Follow the tail, unless the reader has scrolled away from it.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const busy = snapshot.scheduler.busy;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title="Reasoning"
        help="What the agent read, what it made of it, and why it did or did not trade. Every line is the agent's own working, in the order it happened."
        right={
          <span className="whitespace-nowrap text-xs text-muted">
            {snapshot.scheduler.beats} cycle{snapshot.scheduler.beats === 1 ? "" : "s"} run
          </span>
        }
      />

      {lines.length === 0 ? (
        <Empty>
          Nothing to show yet. The next cycle reads the news, scores it against the chart, and
          writes what it decided here.
        </Empty>
      ) : (
        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-void px-4 py-3"
        >
          <ol className="num space-y-1 text-xs leading-relaxed">
            {lines.map((line) => (
              <li
                key={line.id}
                className={`flex gap-3 ${fresh.has(line.id) ? "rise" : ""}`}
              >
                <span className="shrink-0 text-faint tabular-nums">{clockOf(line.at)}</span>
                <span className={`w-14 shrink-0 font-semibold ${KIND_TONE[line.kind]}`}>
                  {line.kind}
                </span>
                <span
                  className={
                    line.kind === "BUDGET" && line.text.startsWith("BLOCK")
                      ? "text-down"
                      : line.kind === "THESIS" || line.kind === "CHART"
                        ? "text-muted"
                        : "text-ink2"
                  }
                >
                  {line.text}
                </span>
              </li>
            ))}

            {/* The prompt. Always last, always moving, so the pane never reads
             * as a screenshot of something that finished. */}
            <li className="flex gap-3 pt-1">
              <span className="shrink-0 text-faint tabular-nums">{clockOf(new Date(now).toISOString())}</span>
              <span className="w-14 shrink-0 font-semibold text-brand">omon</span>
              <span className="text-muted">
                {busy ? "thinking" : `idle, next cycle in ${countdown(snapshot.scheduler.nextAt, now)}`}
                <span
                  className="ml-1 inline-block h-3 w-1.5 translate-y-0.5 bg-brand"
                  style={{ animation: "omon-blink 1.1s steps(1) infinite" }}
                  aria-hidden
                />
              </span>
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}

/* ---------- system ---------- */


/**
 * Everything an engineer wants and nobody else does.
 *
 * All of this used to be on the main screen: six unlabelled status pills, the
 * rail each market read took, the storage directory. It is genuinely useful and
 * it was genuinely in the way, so it moved behind a button rather than being
 * deleted. A judge who wants to check the claims opens it in one click.
 */
function SystemPanel({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const { seams, payment, prices, limits, storage, ledger, usage } = snapshot;

  const rows: Array<[string, { mode: string; reason: string }]> = [
    ["Intel Agent", seams.intelAgent],
    ["Signal Agent", seams.signalAgent],
    ["News feed", seams.news],
    ["Spot exchange", seams.exchange],
    ["Futures", seams.futures],
    ["Binance MCP", seams.mcp],
    ["Skill Hub", seams.skillHub],
  ];

  return (
    <div className="border-t border-edge bg-base">
      <div className="mx-auto grid max-w-7xl gap-6 px-5 py-5 sm:px-8 lg:grid-cols-3">
        <div>
          <h3 className="eyebrow mb-2.5">Connections</h3>
          <ul className="space-y-1.5">
            {rows.map(([label, seam]) => {
              const live = seam.mode === "live" || seam.mode === "in use";
              return (
                <li key={label} className="flex items-center gap-2 text-xs">
                  <StatusDot
                    tone={live ? "up" : seam.mode === "off" ? "muted" : "warn"}
                    pulse={false}
                  />
                  <span className="text-ink2">{label}</span>
                  <span
                    className={`ml-auto text-right ${live ? "text-up" : "text-muted"}`}
                    title={plain(seam.reason)}
                  >
                    {seam.mode}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <h3 className="eyebrow mb-2.5">Live marks</h3>
          <ul className="space-y-1.5">
            {Object.entries(prices).map(([symbol, price]) => (
              <li key={symbol} className="flex items-center gap-2 text-xs">
                <span className="text-ink2">{symbol.replace("USDT", "")}</span>
                <span className="num ml-auto text-ink">{mark(Number(price))}</span>
              </li>
            ))}
            {Object.keys(prices).length === 0 ? (
              <li className="text-xs text-muted">No prices this cycle.</li>
            ) : null}
          </ul>

          <h3 className="eyebrow mt-4 mb-2.5">Read over</h3>
          <ul className="space-y-1.5">
            {Object.entries(usage).map(([what, use]) => (
              <li key={what} className="flex items-center gap-2 text-xs">
                <span className="text-ink2">{what}</span>
                <span className="ml-auto text-muted" title={use.reason ?? use.tool ?? ""}>
                  {use.via}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="eyebrow mb-2.5">Limits and storage</h3>
          <dl className="space-y-1.5 text-xs">
            <div className="flex gap-2">
              <dt className="text-ink2">Per trade</dt>
              <dd className="num ml-auto text-ink">{usd(limits.maxTradeUsd)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink2">Per day</dt>
              <dd className="num ml-auto text-ink">{usd(limits.dailyTradeUsd)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink2">Max leverage</dt>
              <dd className="num ml-auto text-ink">{snapshot.maxLeverage}x</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink2">Tradable</dt>
              <dd className="ml-auto text-right text-ink">
                {limits.allowedSymbols.join(", ")}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink2">Payment rail</dt>
              <dd className="ml-auto text-right text-ink">
                {payment.rail} on {payment.network}, {payment.price} {payment.token}
              </dd>
            </div>
            {payment.b402 ? <B402Row b402={payment.b402} /> : null}
            <div className="flex gap-2">
              <dt className="text-ink2">On disk</dt>
              <dd className="ml-auto text-right text-ink">
                {storage.persisting
                  ? `${ledger.spotFillCount} spot, ${ledger.futuresFillCount} futures`
                  : "not saving"}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}


/**
 * The Binance OnchainPay row in diagnostics.
 *
 * Two lines, and the second one is the point: a rail that is mapped but not
 * settling has to say BOTH halves on screen at once. Showing only "b402" over a
 * figure that landed on Base Sepolia is the exact misreading this row exists to
 * prevent, so the not-settling case leads with that fact and names what is
 * missing rather than showing a green pill and hoping nobody clicks through.
 */
function B402Row({ b402 }: { b402: Record<string, unknown> }) {
  const settling = b402.settling === true;
  const missing = [
    ...(((b402.missing as { credentials?: string[] } | undefined)?.credentials) ?? []),
    ...(((b402.missing as { token?: string[] } | undefined)?.token) ?? []),
  ];

  return (
    <div className="flex gap-2">
      <dt className="text-ink2">B402</dt>
      <dd className="ml-auto text-right text-ink">
        {settling ? (
          <>settling on {String(b402.network)}</>
        ) : (
          <>
            <span className="text-ink2">mapped, not settling</span>
            <span className="block text-ink2">
              {missing.length > 0 ? `${missing.length} var${missing.length === 1 ? "" : "s"} unset` : "credentials pending"}
              {" — see /api/b402"}
            </span>
          </>
        )}
      </dd>
    </div>
  );
}
