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
import { evaluateTrade, isClosing, limitsFromEnv } from "@/lib/budget";
import { getPrices, placeOrder, MIN_NOTIONAL_USD } from "@/lib/exchange";
import { futuresMark, futuresMinNotional, placeFuturesOrder, placeableNotional } from "@/lib/futures";
import { computeFuturesPnl, computePnl, drawdownUsd, realizedPnlWindowUsd } from "@/lib/pnl";
import { exitsFor, type ExitProposal } from "@/lib/exits";
import { refreshIntel, intelCacheStatus } from "@/lib/intel-cache";
import { refreshSignals, signalCacheStatus } from "@/lib/signal-cache";
import {
  fills,
  hasTradedSignal,
  hasVetoedSignal,
  recordAction,
  recordFill,
  spentTodayUsd,
} from "@/lib/ledger";
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
): Promise<{
  holdingUsd: number | undefined;
  perpQty: number;
  minNotionalUsd: number | undefined;
  marks: Record<string, string>;
  /**
   * When the mark used below was read, or undefined if the read failed.
   *
   * Within one beat this is near-zero by construction, and that is the point:
   * the gate's freshness check should normally pass. It earns its keep on a slow
   * beat — `futuresMinNotional()` and the sizing snap both await between this
   * read and the gate call — and the day someone puts a cache in front of
   * `getPrices()`. A guard that currently passes is still doing work.
   */
  pricedAt: number | undefined;
}> {
  let marks: Record<string, string> = {};
  let pricedAt: number | undefined;
  try {
    marks = await getPrices([symbol]);
    pricedAt = Date.now();
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
    return { holdingUsd: perp?.notionalUsd, perpQty: perp?.qty ?? 0, minNotionalUsd, marks, pricedAt };
  }

  const spot = computePnl(rows, marks).positions.find((p) => p.symbol === symbol);
  return {
    holdingUsd: spot?.marketValueUsd ?? undefined,
    perpQty: 0,
    minNotionalUsd: undefined,
    marks,
    pricedAt,
  };
}



/**
 * The first exit the exchange would actually accept.
 *
 * An unresolvable minimum sizes optimistically and lets the order through, the
 * same call this file already makes when opening: a refused order is visible in
 * the ledger, whereas one suppressed by a guess is not.
 */
async function firstPlaceable(
  proposals: ExitProposal[],
  marks: Record<string, string>,
): Promise<ExitProposal | null> {
  for (const p of proposals) {
    let floor = MIN_NOTIONAL_USD;

    if (p.venue === "futures") {
      try {
        floor = Math.max(floor, await futuresMinNotional(p.symbol, Number(marks[p.symbol])));
      } catch {
        // Unknown floor: let it through and let Binance answer.
      }
    }

    if (p.sizeUsd >= floor) return p;

    console.warn(
      `[tick] ${p.symbol} ${p.venue} is stranded: $${p.sizeUsd.toFixed(2)} to close, ` +
        `below the $${floor.toFixed(2)} minimum. ${p.rule} deferred.`,
    );
  }

  return null;
}

/**
 * The exit the book is asking for, if any, as a signal.
 *
 * Exits ride the existing trade path rather than getting one of their own. That
 * path already derives `reduceOnly` from the position, snaps the notional to
 * something the exchange accepts, runs the thirteen-check gate, and writes the
 * ledger — and a second copy of all of that, reachable only when selling, is
 * exactly the code that rots and then loses money.
 *
 * `intelId` is `"exit"` rather than a real row: nothing was read to reach this
 * decision. That is the honest value and it keeps exits visible in the ledger as
 * a distinct kind of trade.
 */
async function exitSignal(): Promise<{ signal: Signal; exit: ExitProposal } | null> {
  const rows = fills();
  if (rows.length === 0) return null;

  const symbols = [
    ...new Set([
      ...computePnl(rows).positions.filter((p) => p.qty > 0).map((p) => p.symbol),
      ...computeFuturesPnl(rows).positions.filter((p) => p.qty !== 0).map((p) => p.symbol),
    ]),
  ];
  if (symbols.length === 0) return null;

  let marks: Record<string, string> = {};
  try {
    marks = await getPrices(symbols);
  } catch (err) {
    // No marks, no exits. exitsFor() skips unpriced positions anyway; bailing
    // here just avoids folding the ledger twice to reach the same answer.
    console.warn("[tick] could not price open positions:", err);
    return null;
  }

  const proposals = exitsFor({
    spot: computePnl(rows, marks).positions,
    futures: computeFuturesPnl(rows, marks).positions,
    now: Date.now(),
  });

  // Drop exits the exchange would refuse for being too small, and do it HERE
  // rather than letting the gate catch them downstream.
  //
  // This is a starvation bug, not a tidiness one. Closing a $14.79 perp rounds
  // the quantity down to the symbol's step and can leave $7.40 behind — below
  // BNBUSDT's $7.53 futures minimum, so no order of any size can clear it. The
  // position is stranded until it grows or a human intervenes. That would be
  // merely untidy, except exits run BEFORE the model: a permanently refused exit
  // would pre-empt every beat forever and the agent would never trade again.
  //
  // So an exit that cannot be placed is not an exit. The beat falls through to
  // intel and the dust waits for a beat where it can actually be cleared.
  const exit = await firstPlaceable(proposals, marks);
  if (!exit) return null;

  return {
    exit,
    signal: {
      id: `exit_${exit.rule}_${exit.symbol}_${Date.now().toString(36)}`,
      intelId: "exit",
      symbol: exit.symbol,
      side: exit.side,
      sizeUsd: exit.sizeUsd,
      venue: exit.venue,
      leverage: 1,
      thesis: `${exit.rule}: ${exit.reason}`,
      createdAt: new Date().toISOString(),
    },
  };
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

  // Exits run before intel, and that ordering is the whole point. An open
  // position past its stop is a decision the book has already made; asking a
  // model for a new opinion first would spend two Gemini calls and a beat to
  // arrive at it later. When an exit fires this beat skips the model entirely.
  const exiting = opts.sizeUsd === undefined ? await exitSignal() : null;

  const intel = exiting ? null : await refreshIntel({ force: opts.force });
  const intelStatus = intelCacheStatus();
  const intelRow = {
    rows: intel?.length ?? 0,
    fresh: intelStatus.fresh,
    lastError: intelStatus.lastError,
  };

  const signals = exiting ? [] : await refreshSignals({ force: opts.force });
  const signal = exiting ? exiting.signal : (signals[0] ?? null);

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

  // One signal, one verdict.
  //
  // The signal cache serves the same newest row for its whole TTL, so beats
  // inside that window all see this signal — and without this guard each of
  // them re-submits an idea that has already been answered. Two ways an answer
  // can be final, and both count:
  //
  //   traded  — an order reached the exchange. Trading it again doubles it.
  //   vetoed  — the gate refused it. The gate is a pure function of the signal
  //             and the ledger, so asking again returns the same no.
  //
  // The second arm was missing until 2026-09-08 and it cost 138 of 236 actions
  // on the first long run: one $10 BTCUSDT futures signal was refused 58 times
  // over 4h45m against a $50 exchange floor. See hasVetoedSignal().
  //
  // The manual override is exempt: pressing the button to demonstrate a refusal
  // must work on whatever signal is on screen, and a refusal never reaches the
  // exchange. An exit's id is minted fresh each time and was never traded, so
  // this guard cannot catch one. Checked explicitly anyway: a rule that
  // silently stopped stops from firing would be the worst possible bug here.
  if (!exiting && opts.sizeUsd === undefined) {
    const settled = hasTradedSignal(signal.id)
      ? "signal already traded, waiting for new intel"
      : hasVetoedSignal(signal.id)
        ? "signal already refused, waiting for new intel"
        : null;

    if (settled) {
      return finish({
        ok: true,
        skipped: settled,
        intel: intelRow,
        signal,
        decision: null,
        order: null,
        orderError: null,
      });
    }
  }

  const proposedSizeUsd =
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

  // Take what is left rather than asking for what is gone.
  //
  // The daily cap is a ceiling on the day, not a verdict on the idea. A $75
  // signal against $43.76 of remaining budget is a $43.76 trade, and refusing
  // it outright throws away a position the leash would have permitted. The
  // 2026-09-06..08 run blocked one $75 BNBUSDT idea nine times in 40 minutes
  // with $43.76 sitting unspent the whole time.
  //
  // Only OPENS are trimmed, which is why this sits below `reduceOnly` rather
  // than up with the proposed size. A close is exempt from the cap entirely
  // (see src/lib/budget.ts) and has to go out at the size that actually
  // flattens the position — trimming one would leave a residue and call it
  // closed, which is the exact bug ae2e179 fixed from the other direction.
  //
  // The manual override is exempt too: the demo's BLOCKED beat is a
  // deliberately oversized trade, and quietly shrinking it into an ALLOW would
  // delete the one thing that beat exists to show.
  //
  // Clamping BEFORE the futures snap is deliberate. If the trimmed figure lands
  // under the symbol's floor the snap will not lift it — it only closes rounding
  // gaps, never sizing gaps — and the gate refuses it in words, which is the
  // honest answer: there is not enough budget left to place a legal order.
  const closing = isClosing({ venue, side: signal.side, reduceOnly });
  const remainingTodayUsd = Math.max(0, limitsFromEnv().dailyTradeUsd - spentTodayUsd());
  const requestedSizeUsd =
    opts.sizeUsd === undefined && !closing
      ? Math.min(proposedSizeUsd, remainingTodayUsd)
      : proposedSizeUsd;

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

  // The two ledger-wide risk numbers. Both fold the same fill log the console
  // renders, so a halt the gate reports is a halt a viewer can already see the
  // cause of, and neither can disagree with the headline P&L.
  const ledger = fills();
  const realizedPnl24hUsd = realizedPnlWindowUsd(ledger);
  const drawdown = drawdownUsd(ledger, position.marks);

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
    // How old the mark backing this size is. Undefined when the price read
    // failed, which skips the check rather than claiming a freshness the beat
    // cannot vouch for.
    quoteAgeMs: position.pricedAt === undefined ? undefined : Date.now() - position.pricedAt,
    realizedPnl24hUsd,
    drawdownUsd: drawdown,
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
    // An operator typed a size. Keyed off `opts.sizeUsd` rather than off a
    // size comparison, so the budget trim below cannot masquerade as a human.
    ...(opts.sizeUsd === undefined ? {} : { proposedSizeUsd: signal.sizeUsd, overridden: true }),
    // The day's remaining budget, not an operator decision and not the
    // exchange's step. Its own fact for the same reason `snapped` is one.
    ...(requestedSizeUsd === proposedSizeUsd
      ? {}
      : { preTrimSizeUsd: proposedSizeUsd, trimmed: true, remainingTodayUsd }),
    // The exchange's step, not an operator decision, so it is recorded as its
    // own fact rather than folded into `overridden`.
    ...(sizeUsd === requestedSizeUsd ? {} : { preSnapSizeUsd: requestedSizeUsd, snapped: true }),
    // Every check the gate ran, so a refusal in the ledger can be read back
    // months later as "check 9 of 13 stopped this, and here is what the other
    // twelve concluded" rather than one sentence with no context. This is what
    // the console's veto log renders.
    checks: decision.checks,
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
