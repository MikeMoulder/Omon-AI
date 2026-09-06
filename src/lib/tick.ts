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
 *
 * ## Venue routing
 *
 * A signal now carries a venue, and this is the only place that acts on it.
 * Two facts about the position have to be established BEFORE the budget layer
 * runs, because both change the verdict:
 *
 *   - **what Omon holds on spot**, so a SELL for more than it owns is refused
 *     here with a sentence rather than bouncing off Binance with -2010;
 *   - **whether a futures order closes or opens**, because a close is exempt
 *     from the daily cap and must be sent `reduceOnly` so an overshoot shrinks
 *     the position instead of silently flipping it into the opposite trade.
 *
 * Both are derived from this ledger's own fills rather than asked of the
 * exchange, so the number the budget layer checks is the same number the
 * console shows. `reduceOnly` is decided here and never taken from the model:
 * whether an order closes a position is a fact about the position, not an
 * opinion the Signal Agent gets to have.
 */
import type { Decision, OrderResult, Signal, Venue } from "@/lib/types";
import { evaluateTrade, limitsFromEnv } from "@/lib/budget";
import { getPrices, placeOrder } from "@/lib/exchange";
import { futuresMark, futuresMinNotional, placeFuturesOrder, placeableNotional } from "@/lib/futures";
import { computeFuturesPnl, computePnl } from "@/lib/pnl";
import { refreshIntel, intelCacheStatus } from "@/lib/intel-cache";
import { refreshSignals, signalCacheStatus } from "@/lib/signal-cache";
import { fills, hasTradedSignal, recordAction, recordFill, spentTodayUsd } from "@/lib/ledger";
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

/**
 * What Omon's own fills say it currently has in one symbol, priced live.
 *
 * Derived from the ledger rather than read off the exchange, deliberately. The
 * Spot Demo account was pre-funded before Omon ever traded, so the exchange
 * balance includes coins this agent did not buy and has no cost basis for.
 * Selling those would book profit measured from a price nobody paid. Asking our
 * own fills keeps the sell guard, the P&L and the console describing the same
 * position.
 *
 * A price that cannot be read returns `holdingUsd: undefined`, which the budget
 * layer treats as "unknown" and refuses to sell against. That is the right way
 * round: an unpriceable position is one we cannot size a sell for.
 */
async function positionFor(
  symbol: string,
  venue: Venue,
): Promise<{ holdingUsd: number | undefined; perpQty: number; minNotionalUsd: number | undefined }> {
  let marks: Record<string, string> = {};
  try {
    marks = await getPrices([symbol]);
  } catch (err) {
    console.warn(`[tick] could not price ${symbol}:`, err);
  }

  const rows = fills();

  if (venue === "futures") {
    const perp = computeFuturesPnl(rows, marks).positions.find((p) => p.symbol === symbol);
    // Futures minimums are per symbol and some are larger than the per-trade
    // cap. Resolved here so the budget layer can refuse in words rather than
    // letting the order bounce off Binance. See futuresMinNotional().
    const mark = Number(marks[symbol]);
    let minNotionalUsd: number | undefined;
    try {
      minNotionalUsd = await futuresMinNotional(symbol, mark);
    } catch {
      // Unknown floor sizes optimistically. A refused order is visible; an
      // order suppressed by a guess is not.
    }
    return { holdingUsd: perp?.notionalUsd, perpQty: perp?.qty ?? 0, minNotionalUsd };
  }

  const spot = computePnl(rows, marks).positions.find((p) => p.symbol === symbol);
  return { holdingUsd: spot?.marketValueUsd ?? undefined, perpQty: 0, minNotionalUsd: undefined };
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
      skipped: "signal already traded, waiting for new intel",
      intel: intelRow,
      signal,
      decision: null,
      order: null,
      orderError: null,
    });
  }

  const requestedSizeUsd =
    opts.sizeUsd !== undefined && Number.isFinite(opts.sizeUsd) && opts.sizeUsd > 0
      ? opts.sizeUsd
      : signal.sizeUsd;

  const venue: Venue = signal.venue === "futures" ? "futures" : "spot";
  const leverage = venue === "futures" ? Math.max(1, Math.floor(signal.leverage ?? 1)) : 1;

  // What this ledger says Omon holds, priced at the live mark. Both branches
  // need a price, and the one call serves both. A price that cannot be read
  // leaves `holdingUsd` undefined, and the budget layer refuses the sell rather
  // than guessing at a position it could not value.
  const position = await positionFor(signal.symbol, venue);

  // A futures order that runs against an open position is a close, and the
  // exchange must be told so. Derived, never taken from the model.
  const reduceOnly =
    venue === "futures" &&
    position.perpQty !== 0 &&
    Math.sign(position.perpQty) !== (signal.side === "BUY" ? 1 : -1);

  // Round the notional up to something the exchange will actually accept.
  //
  // placeFuturesOrder() rounds the QUANTITY down to the symbol's step, so an
  // approved $20.00 of ETHUSDT went out as 0.008 ETH — $19.99 at a 2499.10 mark
  // — and bounced with "Order's notional must be no smaller than 20" on every
  // beat for two hours. Snapping here rather than inside the order call is what
  // keeps the guarantee that the size the budget layer approves is the size that
  // reaches Binance: the snapped figure is what evaluateTrade() checks against
  // the per-trade cap and what the ledger counts against the daily one. If the
  // snap lands above the cap, the budget layer refuses it in words. Closes are
  // left alone — see placeableNotional().
  let sizeUsd = requestedSizeUsd;
  if (venue === "futures" && !reduceOnly) {
    try {
      const mark = await futuresMark(signal.symbol);
      sizeUsd = await placeableNotional(signal.symbol, requestedSizeUsd, mark);
    } catch (err) {
      // Sizing optimistically on a failed read matches futuresMinNotional():
      // an order Binance refuses is visible in the console, one suppressed by a
      // guess is not.
      console.warn(`[tick] could not snap ${signal.symbol} to a placeable size:`, err);
    }
  }

  const decision = evaluateTrade({
    symbol: signal.symbol,
    sizeUsd,
    spentTodayUsd: spentTodayUsd(),
    venue,
    side: signal.side,
    leverage,
    reduceOnly,
    holdingUsd: position.holdingUsd,
    minNotionalUsd: position.minNotionalUsd,
  });

  const payload = {
    symbol: signal.symbol,
    side: signal.side,
    sizeUsd,
    venue,
    signalId: signal.id,
    intelId: signal.intelId,
    convictionLabel: signal.convictionLabel ?? null,
    ...(venue === "futures" ? { leverage, reduceOnly, marginUsd: sizeUsd / leverage } : {}),
    ...(requestedSizeUsd === signal.sizeUsd
      ? {}
      : { proposedSizeUsd: signal.sizeUsd, overridden: true }),
    // The exchange's step, not an operator decision, so it is recorded as its
    // own fact rather than folded into `overridden`.
    ...(sizeUsd === requestedSizeUsd ? {} : { preSnapSizeUsd: requestedSizeUsd, snapped: true }),
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
    order =
      venue === "futures"
        ? await placeFuturesOrder({
            symbol: signal.symbol,
            side: signal.side,
            sizeUsd,
            leverage,
            reduceOnly,
            // The ceiling for the drift guard: a mark that moves between the
            // snap above and the order itself may cost a step, and clawing it
            // back is allowed only up to the cap the operator set. See
            // placeFuturesOrder().
            maxNotionalUsd: limitsFromEnv().maxTradeUsd,
          })
        : await placeOrder({ symbol: signal.symbol, side: signal.side, sizeUsd });
  } catch (err) {
    orderError = err instanceof Error ? err.message : String(err);
  }

  // An ALLOW whose order failed is recorded with orderId null, so it does not
  // count against the daily budget — nothing was spent. The reason says why.
  // What the exchange actually posted, which the drift guard can leave a step
  // above the approved size. spentTodayUsd() sums this field, so the daily cap
  // has to see the real notional and not the intended one.
  const filledUsd = order ? Number(order.cummulativeQuoteQty) : NaN;
  const posted = Number.isFinite(filledUsd) && filledUsd > 0 ? filledUsd : null;

  const action = recordAction({
    kind: "trade",
    payload: order
      ? {
          ...payload,
          status: order.status,
          live: order.live,
          ...(posted === null
            ? {}
            : {
                sizeUsd: posted,
                ...(venue === "futures" ? { marginUsd: posted / leverage } : {}),
                ...(posted === sizeUsd ? {} : { approvedSizeUsd: sizeUsd }),
              }),
        }
      : payload,
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
