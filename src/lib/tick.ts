/**
 * One beat of the whole system, callable from anywhere.
 *
 *   refreshIntel() -> refreshSignals() -> evaluateTrade() -> placeOrder() on
 *   ALLOW, and recordAction() either way.
 *
 * This lives in lib rather than in the route because two things drive it now:
 * the scheduler (src/lib/scheduler.ts, the normal case) and POST /api/cron/tick
 * (a human, or the console's buttons). Both must be the same beat — a demo
 * button that runs different code from the scheduler is a demo that proves
 * nothing about the running system.
 *
 * Single-flight, and that is load-bearing rather than tidy: the scheduler firing
 * while someone presses the button would run two beats concurrently, double-spend
 * the Gemini quota, and race two orders against one budget check. Overlapping
 * callers get the in-flight beat's result instead.
 *
 * Recording the verdict is not bookkeeping, it is the product. A refusal that
 * leaves no trace is indistinguishable from having no budget layer at all, so
 * BLOCK is written down with the same weight as a fill.
 */
import type { Decision, OrderResult, Signal } from "@/lib/types";
import { evaluateTrade } from "@/lib/budget";
import { placeOrder } from "@/lib/exchange";
import { refreshIntel, intelCacheStatus } from "@/lib/intel-cache";
import { refreshSignals, signalCacheStatus } from "@/lib/signal-cache";
import { hasTradedSignal, recordAction, recordFill, spentTodayUsd } from "@/lib/ledger";
import { readDoc, writeDoc } from "@/lib/store";

/**
 * What `data/tick.json` holds.
 *
 * The beat counter and the last verdict are on screen, so losing them on a
 * restart made a running system read as one that had never done anything —
 * "waiting for the first beat" under a console full of recovered history.
 */
type TickDoc = { beats: number; last: TickResult | null };

const DOC = "tick";

export type TickResult = {
  ok: boolean;
  at: string;
  tookMs: number;
  /** What drove this beat. The console shows it so an auto beat is not mistaken for a click. */
  source: "schedule" | "manual";
  /** Why the beat stopped early, when it did. Null on a beat that reached a verdict. */
  skipped: string | null;
  intel: { rows: number; fresh: boolean; lastError: string | null };
  signal: Signal | null;
  decision: Decision | null;
  order: OrderResult | null;
  orderError: string | null;
};

let last: TickResult | null = null;
let inflight: Promise<TickResult> | null = null;
let beats = 0;
let hydrated = false;

/** Read the counter and last verdict back off the disk, once per process. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;

  const doc = readDoc<TickDoc>(DOC);
  if (!doc) return;
  beats = typeof doc.beats === "number" ? doc.beats : 0;
  last = doc.last ?? null;
}

/** Called from `finish()`, so every beat that reaches a verdict is saved. */
function persist(): void {
  writeDoc(DOC, { beats, last } satisfies TickDoc);
}

/** The most recent beat, or null before the first one ever. */
export function lastTick(): TickResult | null {
  hydrate();
  return last;
}

/**
 * Beats run, across restarts.
 *
 * Was "beats since this process started", which reset to 0 on every restart and
 * made the console look freshly born. The heartbeat is a property of the agent,
 * not of the process serving it.
 */
export function tickCount(): number {
  hydrate();
  return beats;
}

export function tickRunning(): boolean {
  return inflight !== null;
}

async function beat(opts: {
  force: boolean;
  sizeUsd?: number;
  source: "schedule" | "manual";
}): Promise<TickResult> {
  const started = Date.now();
  hydrate();

  const finish = (result: Omit<TickResult, "at" | "tookMs" | "source">): TickResult => {
    last = {
      ...result,
      source: opts.source,
      at: new Date().toISOString(),
      tookMs: Date.now() - started,
    };
    beats += 1;
    persist();
    return last;
  };

  const intel = await refreshIntel({ force: opts.force });
  const intelStatus = intelCacheStatus();
  const intelRow = {
    rows: intel.length,
    fresh: intelStatus.fresh,
    lastError: intelStatus.lastError,
  };

  const signals = await refreshSignals({ force: opts.force });
  const signal = signals[0] ?? null;

  if (!signal) {
    // Not a failure. A cold intel cache, a quiet news hour or a model outage all
    // land here, and none of them is a reason to invent a trade.
    return finish({
      ok: true,
      skipped: signalCacheStatus().lastError ?? "no signal available yet",
      intel: intelRow,
      signal: null,
      decision: null,
      order: null,
      orderError: null,
    });
  }

  // One signal, one trade.
  //
  // The signal cache serves the same newest row for its whole TTL, so beats
  // inside that window all see this signal — and without this guard each of
  // them places another order for an idea already acted on. The manual
  // override is exempt: pressing the button to demonstrate a refusal must work
  // on whatever signal is on screen, and a refusal never reaches the exchange.
  if (opts.sizeUsd === undefined && hasTradedSignal(signal.id)) {
    return finish({
      ok: true,
      skipped: "signal already traded — waiting for new intel",
      intel: intelRow,
      signal,
      decision: null,
      order: null,
      orderError: null,
    });
  }

  const sizeUsd =
    opts.sizeUsd !== undefined && Number.isFinite(opts.sizeUsd) && opts.sizeUsd > 0
      ? opts.sizeUsd
      : signal.sizeUsd;

  const decision = evaluateTrade({
    symbol: signal.symbol,
    sizeUsd,
    spentTodayUsd: spentTodayUsd(),
  });

  const payload = {
    symbol: signal.symbol,
    side: signal.side,
    sizeUsd,
    signalId: signal.id,
    intelId: signal.intelId,
    convictionLabel: signal.convictionLabel ?? null,
    ...(sizeUsd === signal.sizeUsd ? {} : { proposedSizeUsd: signal.sizeUsd, overridden: true }),
  };

  if (decision.decision !== "ALLOW") {
    recordAction({
      kind: "trade",
      payload,
      decision: decision.decision,
      reason: decision.reason,
      orderId: null,
    });
    return finish({
      ok: true,
      skipped: null,
      intel: intelRow,
      signal,
      decision,
      order: null,
      orderError: null,
    });
  }

  let order: OrderResult | null = null;
  let orderError: string | null = null;

  try {
    order = await placeOrder({ symbol: signal.symbol, side: signal.side, sizeUsd });
  } catch (err) {
    orderError = err instanceof Error ? err.message : String(err);
  }

  // An ALLOW whose order failed is recorded with orderId null, so it does not
  // count against the daily budget — nothing was spent. The reason says why.
  const action = recordAction({
    kind: "trade",
    payload: order ? { ...payload, status: order.status, live: order.live } : payload,
    decision: decision.decision,
    reason: orderError ? `order failed: ${orderError}` : decision.reason,
    orderId: order?.orderId ?? null,
  });

  // The execution, separately and with its price. The Action above says the
  // trade was permitted; only this says what it cost, and only this can become
  // a position. A partial fill is still a fill — recordFill() takes whatever
  // quantity actually moved and ignores an order that moved none.
  if (order) recordFill({ actionId: action.id, order });

  return finish({
    ok: orderError === null,
    skipped: null,
    intel: intelRow,
    signal,
    decision,
    order,
    orderError,
  });
}

/**
 * Run one beat, or join the one already running.
 *
 * Never throws: a beat that blows up records the reason and returns it, because
 * the scheduler's interval must survive a bad news hour or an exchange outage.
 */
export async function runTick(
  opts: { force?: boolean; sizeUsd?: number; source?: "schedule" | "manual" } = {},
): Promise<TickResult> {
  if (inflight) return inflight;

  inflight = beat({
    force: opts.force ?? false,
    sizeUsd: opts.sizeUsd,
    source: opts.source ?? "manual",
  })
    .catch((err) => {
      const result: TickResult = {
        ok: false,
        at: new Date().toISOString(),
        tookMs: 0,
        source: opts.source ?? "manual",
        skipped: err instanceof Error ? err.message : String(err),
        intel: { rows: 0, fresh: false, lastError: null },
        signal: null,
        decision: null,
        order: null,
        orderError: null,
      };
      last = result;
      persist();
      return result;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
