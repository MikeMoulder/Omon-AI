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
 */
import type { Fill } from "@/lib/types";

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
  unbased: number;
};

/**
 * Fold fills into positions and profit.
 *
 * `marks` is the same `Record<symbol, priceString>` the console already renders
 * at the top of the page, so the mark used in the profit is the mark on screen.
 */
export function computePnl(fills: Fill[], marks: Record<string, string> = {}): PnlSummary {
  // Order matters — average cost is path dependent. Callers hold rows newest
  // first, so this sort is doing real work, not tidying.
  const ordered = [...fills].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pots = new Map<string, Pot>();

  for (const fill of ordered) {
    if (!Number.isFinite(fill.qty) || fill.qty <= 0) continue;

    const pot: Pot = pots.get(fill.symbol) ?? {
      qty: 0,
      cost: 0,
      realized: 0,
      fills: 0,
      lastFillAt: fill.createdAt,
      unbased: 0,
    };
    pot.fills += 1;
    pot.lastFillAt = fill.createdAt;

    if (fill.side === "BUY") {
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
