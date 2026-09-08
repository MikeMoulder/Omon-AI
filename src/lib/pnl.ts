/**
 * Positions and profit, derived from fills.
 *
 * This is the number the console was missing. Everything else on screen answers
 * "did it do something" — this answers "was it worth doing", which is the only
 * question anyone actually asks of a trading agent.
 *
 * Pure functions over rows, no state and no network, for the same reason
 * src/lib/budget.ts is: it must be checkable by a test that spends nothing, and
 * it must produce the same answer as the numbers already on the page rather than
 * a second opinion about them.
 *
 * ## Average cost, not FIFO
 *
 * Each BUY adds base quantity and quote cost to the symbol's pot. Each SELL
 * closes at the running average, realising `qty * (fillPrice - avgCost)` and
 * removing that cost from the pot. FIFO would give a different split between
 * realised and unrealised on a part-closed position; the total is identical, and
 * average cost is the one a viewer can verify by hand from the rows on screen.
 *
 * ## Selling what this ledger never bought
 *
 * The Spot Demo account is pre-funded — 0.008 BNB was there before Omon placed
 * anything. A SELL can therefore exceed the quantity these fills accumulated.
 * Those units have no cost basis here, so they contribute NO profit rather than
 * a fabricated one measured from zero, and they are counted in `unbasedSells` so
 * the console can say the number is partial instead of quietly understating it.
 *
 * ## Unrealised needs a mark
 *
 * An open position with no live price is reported with `markPrice: null` and
 * excluded from the unrealised total, and its symbol is listed in `unpriced`.
 * A missing price must read as missing, never as a zero that drags P&L down.
 *
 * ## Spot and futures are accounted separately, and never summed into one row
 *
 * `computePnl()` is spot. `computeFuturesPnl()` is futures. They are different
 * arithmetic, not a shared function with a flag:
 *
 *   - a spot position is long-only, and its cost basis is money that actually
 *     left the account;
 *   - a perp position is SIGNED, its "cost" is margin posted rather than spent,
 *     it can flip from long to short in a single fill, and a short profits when
 *     the mark falls, which average-cost spot arithmetic reports as a loss.
 *
 * Running futures fills through the spot fold does not merely mis-round, it
 * reports the sign backwards on every short. The two totals are shown side by
 * side on the console for the same reason trading profit and x402 revenue are:
 * one combined number would imply a fungibility that is not there.
 */
import type { Fill } from "@/lib/types";
import { venueOf } from "@/lib/types";

/** Below this, a residual position is float noise from average-cost arithmetic. */
const DUST_QTY = 1e-12;

export type Position = {
  symbol: string;
  /** Base asset still held from these fills. Zero once fully closed. */
  qty: number;
  /** Average price paid for the open quantity. Zero when flat. */
  avgCostUsd: number;
  /** What the open quantity cost. */
  costBasisUsd: number;
  /** Live mark, or null when no price was available this beat. */
  markPrice: number | null;
  /** qty * mark, or null when unpriced. */
  marketValueUsd: number | null;
  /** Open profit, or null when unpriced. */
  unrealizedUsd: number | null;
  /** Open profit as a fraction of cost, or null when unpriced or flat. */
  unrealizedPct: number | null;
  /** Booked profit from the closes so far. Survives the position going flat. */
  realizedUsd: number;
  fills: number;
  lastFillAt: string;
  /**
   * When this run of exposure began — the fill that took the symbol from flat
   * to open, not the most recent one. What the time-stop measures against.
   */
  openedAt: string;
};

export type PnlSummary = {
  /** Open positions first, then closed ones that still carry realised profit. */
  positions: Position[];
  /** Booked profit across every symbol. */
  realizedUsd: number;
  /** Open profit across every priced position. */
  unrealizedUsd: number;
  /** realized + unrealized. The headline number. */
  totalUsd: number;
  /** What the open positions cost. The denominator for `totalPct`. */
  costBasisUsd: number;
  /** What they are worth now, counting only priced positions. */
  marketValueUsd: number;
  /** Total profit against cost basis, or null when nothing is open. */
  totalPct: number | null;
  openCount: number;
  fillCount: number;
  /** Open symbols with no live mark — their profit is not in the totals. */
  unpriced: string[];
  /**
   * Base units sold that these fills never bought, per symbol. Non-empty means
   * the account held the asset before Omon did, and P&L covers only Omon's part.
   */
  unbasedSells: Record<string, number>;
};

type Pot = {
  qty: number;
  cost: number;
  realized: number;
  fills: number;
  lastFillAt: string;
  /**
   * When the CURRENT run of exposure began — the fill that took this symbol
   * from flat to open. Reset every time the pot flattens, so a re-entry starts
   * a new clock rather than inheriting the old one.
   *
   * Distinct from `lastFillAt` on purpose, and the distinction is what the
   * time-stop runs on. See src/lib/exits.ts.
   */
  openedAt: string;
  unbased: number;
};

/**
 * Fold fills into positions and profit.
 *
 * `marks` is the same `Record<symbol, priceString>` the console already renders
 * at the top of the page, so the mark used in the profit is the mark on screen.
 */
export function computePnl(fills: Fill[], marks: Record<string, string> = {}): PnlSummary {
  // Spot only. Futures rows go to computeFuturesPnl() — running them through
  // this fold would report every short's sign backwards. Rows written before
  // futures existed carry no venue and are spot, which is what they were.
  const spotOnly = fills.filter((f) => venueOf(f) === "spot");

  // Order matters — average cost is path dependent. Callers hold rows newest
  // first, so this sort is doing real work, not tidying.
  const ordered = [...spotOnly].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pots = new Map<string, Pot>();

  for (const fill of ordered) {
    if (!Number.isFinite(fill.qty) || fill.qty <= 0) continue;

    const pot: Pot = pots.get(fill.symbol) ?? {
      qty: 0,
      cost: 0,
      realized: 0,
      fills: 0,
      lastFillAt: fill.createdAt,
      openedAt: fill.createdAt,
      unbased: 0,
    };
    pot.fills += 1;
    pot.lastFillAt = fill.createdAt;

    if (fill.side === "BUY") {
      // Flat to open starts the clock. Adding to a position that is already
      // open does NOT — averaging in is not a new position, and treating it as
      // one is what let a 6h time-stop never mature across 22 BTCUSDT buys.
      if (pot.qty === 0) pot.openedAt = fill.createdAt;
      pot.qty += fill.qty;
      pot.cost += fill.quoteUsd;
    } else {
      const closing = Math.min(fill.qty, pot.qty);
      if (closing > 0) {
        const avg = pot.cost / pot.qty;
        pot.realized += closing * (fill.price - avg);
        pot.qty -= closing;
        pot.cost -= closing * avg;
      }
      // See the header: units with no basis here earn no profit here.
      if (fill.qty > closing) pot.unbased += fill.qty - closing;
      if (pot.qty < DUST_QTY) {
        pot.qty = 0;
        pot.cost = 0;
      }
    }

    pots.set(fill.symbol, pot);
  }

  const positions: Position[] = [];
  const unpriced: string[] = [];
  const unbasedSells: Record<string, number> = {};

  let realizedUsd = 0;
  let unrealizedUsd = 0;
  let costBasisUsd = 0;
  let marketValueUsd = 0;

  for (const [symbol, pot] of pots) {
    const rawMark = Number(marks[symbol]);
    const markPrice = Number.isFinite(rawMark) && rawMark > 0 ? rawMark : null;
    const open = pot.qty > 0;

    const marketValue = open && markPrice !== null ? pot.qty * markPrice : null;
    const unrealized = marketValue === null ? null : marketValue - pot.cost;

    if (open && markPrice === null) unpriced.push(symbol);
    if (pot.unbased > 0) unbasedSells[symbol] = pot.unbased;

    realizedUsd += pot.realized;
    if (open) costBasisUsd += pot.cost;
    if (unrealized !== null) {
      unrealizedUsd += unrealized;
      marketValueUsd += marketValue as number;
    }

    positions.push({
      symbol,
      qty: pot.qty,
      openedAt: pot.openedAt,
      avgCostUsd: open ? pot.cost / pot.qty : 0,
      costBasisUsd: pot.cost,
      markPrice,
      marketValueUsd: marketValue,
      unrealizedUsd: unrealized,
      unrealizedPct: unrealized !== null && pot.cost > 0 ? unrealized / pot.cost : null,
      realizedUsd: pot.realized,
      fills: pot.fills,
      lastFillAt: pot.lastFillAt,
    });
  }

  // Open positions first — they are the ones still moving. Then by size, so the
  // row that matters most is the row nearest the top.
  positions.sort((a, b) => {
    if ((a.qty > 0) !== (b.qty > 0)) return a.qty > 0 ? -1 : 1;
    return (b.marketValueUsd ?? b.costBasisUsd) - (a.marketValueUsd ?? a.costBasisUsd);
  });

  const totalUsd = realizedUsd + unrealizedUsd;

  return {
    positions,
    realizedUsd,
    unrealizedUsd,
    totalUsd,
    costBasisUsd,
    marketValueUsd,
    totalPct: costBasisUsd > 0 ? totalUsd / costBasisUsd : null,
    openCount: positions.filter((p) => p.qty > 0).length,
    fillCount: ordered.length,
    unpriced,
    unbasedSells,
  };
}

/**
 * One perpetual position, folded from this ledger's futures fills.
 *
 * `qty` is SIGNED and that is the entire difference from `Position` above.
 * Negative is a short: it profits when the mark falls, and any arithmetic that
 * treats it as a smaller long gets the sign of the profit wrong rather than the
 * magnitude.
 */
export type PerpPosition = {
  symbol: string;
  /** Signed base quantity. Negative is short, zero is flat. */
  qty: number;
  direction: "long" | "short" | "flat";
  /** Volume-weighted entry for the open quantity. Zero when flat. */
  entryPrice: number;
  /** |qty| * entry. The exposure this position carries. */
  notionalUsd: number;
  /** notional / leverage. What it actually ties up. */
  marginUsd: number;
  /** Leverage of the fills that opened the position now standing. */
  leverage: number;
  /** See `Position.openedAt`. What the time-stop measures against. */
  openedAt: string;
  markPrice: number | null;
  /** Signed open profit, or null when unpriced. */
  unrealizedUsd: number | null;
  /** Open profit against notional, so it compares like-for-like with spot. */
  unrealizedPct: number | null;
  /**
   * Open profit against margin posted — the leveraged return, and the number a
   * futures trader actually means by "up 6%". Shown next to the notional one
   * rather than instead of it, because at 3x they differ by a factor of three
   * and a single unlabelled percentage would be a lie in one direction or the
   * other.
   */
  returnOnMarginPct: number | null;
  /** Booked profit from closes so far. Survives the position going flat. */
  realizedUsd: number;
  fills: number;
  lastFillAt: string;
};

export type FuturesPnlSummary = {
  positions: PerpPosition[];
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
  /** Exposure across open positions. What the daily cap is denominated in. */
  notionalUsd: number;
  /** Margin tied up across open positions. Always notional/leverage or less. */
  marginUsd: number;
  /** Total profit against margin posted. The leveraged return, or null when flat. */
  totalPct: number | null;
  openCount: number;
  longCount: number;
  shortCount: number;
  fillCount: number;
  unpriced: string[];
};

type Perp = {
  qty: number;
  entry: number;
  realized: number;
  leverage: number;
  fills: number;
  lastFillAt: string;
  /** See `Pot.openedAt`. Reset on flat AND on a flip — a reversed position is a new one. */
  openedAt: string;
};

/** Below this, a residual perp position is float noise and reads as flat. */
const DUST_PERP = 1e-10;

/**
 * Fold futures fills into signed positions and profit.
 *
 * Handles the case spot cannot: a fill larger than the open position in the
 * opposite direction CLOSES it and opens a new one the other way, in one order.
 * The close realises at the old entry, the remainder starts at the fill price.
 * Getting this wrong shows up as a position that quietly keeps a stale entry
 * across a flip and reports profit measured from a price it never traded at.
 */
export function computeFuturesPnl(
  fills: Fill[],
  marks: Record<string, string> = {},
): FuturesPnlSummary {
  const ordered = fills
    .filter((f) => venueOf(f) === "futures")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const pots = new Map<string, Perp>();

  for (const fill of ordered) {
    if (!Number.isFinite(fill.qty) || fill.qty <= 0) continue;
    if (!Number.isFinite(fill.price) || fill.price <= 0) continue;

    const pot: Perp = pots.get(fill.symbol) ?? {
      qty: 0,
      entry: 0,
      realized: 0,
      leverage: fill.leverage ?? 1,
      fills: 0,
      lastFillAt: fill.createdAt,
      openedAt: fill.createdAt,
    };
    pot.fills += 1;
    pot.lastFillAt = fill.createdAt;

    const delta = fill.side === "BUY" ? fill.qty : -fill.qty;
    const adding = pot.qty === 0 || Math.sign(pot.qty) === Math.sign(delta);

    if (adding) {
      // Flat to open starts the clock; adding to a live position does not.
      if (pot.qty === 0) pot.openedAt = fill.createdAt;
      // Volume-weighted entry. The leverage of the position becomes the
      // leverage of the fills currently holding it open.
      const total = Math.abs(pot.qty) + Math.abs(delta);
      pot.entry =
        total > 0 ? (Math.abs(pot.qty) * pot.entry + Math.abs(delta) * fill.price) / total : fill.price;
      pot.qty += delta;
      if (fill.leverage) pot.leverage = fill.leverage;
    } else {
      const closeQty = Math.min(Math.abs(pot.qty), Math.abs(delta));
      // Sign of the position being closed decides which way profit runs: a
      // short books profit when the exit price is BELOW the entry.
      pot.realized += closeQty * (fill.price - pot.entry) * Math.sign(pot.qty);

      const flipped = Math.abs(delta) > Math.abs(pot.qty);
      pot.qty += delta;

      if (Math.abs(pot.qty) < DUST_PERP) {
        pot.qty = 0;
        pot.entry = 0;
      } else if (flipped) {
        // The remainder is a brand new position in the other direction, and it
        // was opened at this fill's price, not at the old entry. Its clock
        // starts here too, for exactly the same reason.
        pot.entry = fill.price;
        pot.openedAt = fill.createdAt;
        if (fill.leverage) pot.leverage = fill.leverage;
      }
    }

    pots.set(fill.symbol, pot);
  }

  const positions: PerpPosition[] = [];
  const unpriced: string[] = [];

  let realizedUsd = 0;
  let unrealizedUsd = 0;
  let notionalUsd = 0;
  let marginUsd = 0;

  for (const [symbol, pot] of pots) {
    const rawMark = Number(marks[symbol]);
    const markPrice = Number.isFinite(rawMark) && rawMark > 0 ? rawMark : null;
    const open = pot.qty !== 0;
    const size = Math.abs(pot.qty);
    const notional = size * pot.entry;
    const leverage = Math.max(1, pot.leverage);
    const margin = notional / leverage;

    const unrealized =
      open && markPrice !== null ? size * (markPrice - pot.entry) * Math.sign(pot.qty) : null;

    if (open && markPrice === null) unpriced.push(symbol);

    realizedUsd += pot.realized;
    if (open) {
      notionalUsd += notional;
      marginUsd += margin;
    }
    if (unrealized !== null) unrealizedUsd += unrealized;

    positions.push({
      symbol,
      qty: pot.qty,
      direction: pot.qty > 0 ? "long" : pot.qty < 0 ? "short" : "flat",
      entryPrice: pot.entry,
      notionalUsd: open ? notional : 0,
      marginUsd: open ? margin : 0,
      leverage,
      markPrice,
      unrealizedUsd: unrealized,
      unrealizedPct: unrealized !== null && notional > 0 ? unrealized / notional : null,
      returnOnMarginPct: unrealized !== null && margin > 0 ? unrealized / margin : null,
      realizedUsd: pot.realized,
      fills: pot.fills,
      lastFillAt: pot.lastFillAt,
      openedAt: pot.openedAt,
    });
  }

  // Open first, then by exposure. Same ordering rule as spot: the row that is
  // still moving and carries the most risk sits nearest the top.
  positions.sort((a, b) => {
    if ((a.qty !== 0) !== (b.qty !== 0)) return a.qty !== 0 ? -1 : 1;
    return b.notionalUsd - a.notionalUsd;
  });

  const totalUsd = realizedUsd + unrealizedUsd;

  return {
    positions,
    realizedUsd,
    unrealizedUsd,
    totalUsd,
    notionalUsd,
    marginUsd,
    totalPct: marginUsd > 0 ? totalUsd / marginUsd : null,
    openCount: positions.filter((p) => p.qty !== 0).length,
    longCount: positions.filter((p) => p.qty > 0).length,
    shortCount: positions.filter((p) => p.qty < 0).length,
    fillCount: ordered.length,
    unpriced,
  };
}

export type VenuePnl = {
  spot: PnlSummary;
  futures: FuturesPnlSummary;
  /**
   * The two added up, and the ONLY place they are.
   *
   * Both venues settle in demo USDT, so unlike trading profit and x402 revenue
   * these genuinely are the same unit and a total is meaningful. The console
   * still leads with the split, because "up $4 on spot, down $3 on a short" and
   * "up $1" are different stories about the same agent, and the second one
   * hides which half of the strategy is working.
   */
  totalUsd: number;
  fillCount: number;
};

/** Both venues, folded from one ledger. */
export function computeVenuePnl(
  fills: Fill[],
  marks: Record<string, string> = {},
): VenuePnl {
  const spot = computePnl(fills, marks);
  const futures = computeFuturesPnl(fills, marks);
  return {
    spot,
    futures,
    totalUsd: spot.totalUsd + futures.totalUsd,
    fillCount: spot.fillCount + futures.fillCount,
  };
}

/**
 * The realised equity curve, and the two risk numbers derived from it.
 *
 * The budget gate needs to answer two questions that no single-trade check can:
 * "how much has today already cost?" and "how far below its best is this agent
 * now?" Both are properties of the whole ledger, so they live here next to the
 * fold that produces every other P&L number, rather than being recomputed
 * slightly differently somewhere else.
 *
 * ## Why these are dollars and not percentages
 *
 * A percentage needs a denominator, and the only honest one is account equity,
 * which is not derivable from a fill ledger — it lives at the exchange behind a
 * network call. A gate that must be deterministic and offline cannot make that
 * call, and inventing a denominator (cost basis, notional traded) would produce
 * a number that looks precise and means nothing. Dollars are what the ledger
 * actually knows.
 */

/** Cumulative booked profit after each fill, in order. */
export type EquityPoint = { at: string; realizedUsd: number };

/**
 * Replay the ledger, recording booked profit after every fill.
 *
 * Folds a growing prefix rather than reimplementing the pot math, so this can
 * never drift from the headline number the console shows — it is the same
 * function, called n times. That is O(n^2) in fills, which is free at the
 * hundreds this agent produces and would need a running fold at millions.
 */
export function equityCurve(fills: Fill[]): EquityPoint[] {
  const ordered = [...fills].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return ordered.map((fill, i) => {
    const upTo = ordered.slice(0, i + 1);
    const venue = computeVenuePnl(upTo);
    return {
      at: fill.createdAt,
      realizedUsd: venue.spot.realizedUsd + venue.futures.realizedUsd,
    };
  });
}

/**
 * Booked profit over the trailing window. Negative means the day has cost money.
 *
 * The difference between cumulative realised now and cumulative realised as of
 * the window's start, which is the only way to attribute a close to a day
 * without double-counting the position that opened before it.
 */
export function realizedPnlWindowUsd(
  fills: Fill[],
  now = Date.now(),
  windowMs = 24 * 60 * 60 * 1000,
): number {
  const curve = equityCurve(fills);
  if (curve.length === 0) return 0;

  const start = now - windowMs;
  // Cumulative realised at the last fill before the window opened. Nothing
  // before the window means the agent started flat, which is zero.
  const before = curve.filter((p) => new Date(p.at).getTime() < start).at(-1)?.realizedUsd ?? 0;
  const latest = curve.at(-1)?.realizedUsd ?? 0;

  return latest - before;
}

/**
 * How far below its high-water mark the agent is, in dollars. Never negative.
 *
 * The historical curve is realised-only, because reconstructing what a position
 * was worth at some past instant would need marks this ledger never stored.
 * Today's point is marked to market, so it includes open profit and loss.
 *
 * That asymmetry is deliberate and it errs in the safe direction: during an
 * unrealised run-up the peak is understated, so measured drawdown is larger than
 * the truth and a halt fires earlier than it strictly needs to. For a check
 * whose job is to stop an agent digging, firing early is the correct bias.
 */
export function drawdownUsd(fills: Fill[], marks: Record<string, string> = {}): number {
  const curve = equityCurve(fills);
  const venue = computeVenuePnl(fills, marks);
  const current = venue.totalUsd;

  // The agent starts flat, so zero is always a candidate peak — otherwise an
  // agent that has only ever lost money would report no drawdown at all.
  const peak = Math.max(0, current, ...curve.map((p) => p.realizedUsd));

  return Math.max(0, peak - current);
}
