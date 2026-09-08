/**
 * The ledger. Every movement of money, in one place, in the order it happened.
 *
 * Three kinds of row and they are not the same thing:
 *
 *   purchases — money IN. An outside agent paid a 402 and got the data.
 *   actions   — money OUT, or refused. Every trade the Signal Agent proposed,
 *               with the budget layer's verdict on it, whether or not an order
 *               was placed.
 *   fills     — what the exchange actually executed, with a price. Only these
 *               can produce a position or a P&L; see src/lib/pnl.ts.
 *
 * A BLOCKED trade is recorded exactly like an allowed one, with `orderId: null`
 * and the reason. That is deliberate: a refusal nobody can see is the same as no
 * leash at all, and the console's whole claim is that the leash is visible.
 *
 * This is also the budget's source of truth. `spentToday()` in src/lib/budget.ts
 * derives the daily total from these rows rather than keeping its own counter,
 * so there is no second number that can disagree with what actually happened.
 * Do not add a balance field here.
 *
 * ## Storage is durable as of 2026-09-06
 *
 * Every row is appended to `data/*.jsonl` through src/lib/store.ts and read back
 * at boot. It used to be memory only, and `pm2 restart omon` erased the lot —
 * every purchase, every refusal, every fill, and with the fills the whole P&L.
 * The console came back looking like a machine that had never traded.
 *
 * Two consequences worth knowing, both of them fixes rather than surprises:
 *
 *   - the rolling 24h budget window now survives a restart, so restarting is no
 *     longer a way to hand the agent a fresh $100 to spend;
 *   - `hasTradedSignal()` survives too, so a restart inside a signal's TTL no
 *     longer re-trades an idea that was already acted on.
 *
 * Memory is a bounded view of the file, never the other way round. The file is
 * the record; `MAX_RETAINED` only decides how much of it this process holds.
 */
import type { Action, ActionKind, Decision, Fill, OrderResult, Purchase } from "@/lib/types";
import { venueOf } from "@/lib/types";
import { limitsFromEnv, spentToday } from "@/lib/budget";
import { appendRow, initStore, loadRows } from "@/lib/store";

/**
 * Rows this process holds in memory. Was 50, which was a display cap; now it is
 * a retention cap, and the difference matters: `spentToday()` reads a rolling
 * 24h window out of these rows, and at 50 a busy day could push a trade out of
 * memory while it was still inside its own budget window — quietly handing back
 * spending room that had already been used. The console still shows 12.
 */
const MAX_RETAINED = 500;

const PURCHASES = "purchases";
const ACTIONS = "actions";
const FILLS = "fills";

let purchaseRows: Purchase[] = [];
let actionRows: Action[] = [];

/**
 * Executions, and the third kind of row.
 *
 * Kept apart from `actionRows` because they answer a different question — an
 * Action is the budget layer's verdict, a Fill is what the market did about it —
 * and because they are NOT capped at all. Positions are a running total:
 * dropping the oldest buy would silently move the average cost of a position
 * that is still open, so the feed can forget rows but the ledger cannot.
 */
let fillRows: Fill[] = [];

/** Monotonic within a process, so two events in the same millisecond stay distinct. */
let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

let hydrated = false;

/**
 * Read the ledger back off the disk, once per process.
 *
 * Lazy rather than at module load so importing this file has no side effect —
 * the tests and the smoke scripts import it freely — and called at the top of
 * every exported function, because there is no single entry point that is
 * guaranteed to run first across a route, the tick and the SSE stream.
 *
 * Files are oldest-first (append order); memory is newest-first (feed order).
 * The reverse between them is the only place that convention is bridged.
 *
 * Rows are deduped by id. Nothing should write the same id twice, but a
 * half-flushed append replayed by hand is a cheap thing to be immune to and an
 * expensive thing to debug as a doubled position.
 */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  initStore();

  const dedupe = <T extends { id: string }>(rows: T[]): T[] => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (!row?.id || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  };

  purchaseRows = dedupe(loadRows<Purchase>(PURCHASES).reverse()).slice(0, MAX_RETAINED);
  actionRows = dedupe(loadRows<Action>(ACTIONS).reverse()).slice(0, MAX_RETAINED);
  fillRows = dedupe(loadRows<Fill>(FILLS).reverse());

  // Past every id this process could otherwise mint again in its first
  // millisecond. Date.now() already separates restarts; this removes the doubt.
  seq = purchaseRows.length + actionRows.length + fillRows.length;

  if (purchaseRows.length + actionRows.length + fillRows.length > 0) {
    console.log(
      `[ledger] recovered ${purchaseRows.length} purchase(s), ` +
        `${actionRows.length} action(s), ${fillRows.length} fill(s) from disk`,
    );
  }
}

/**
 * Record a settled payment.
 *
 * Called from src/lib/payment-log.ts once the facilitator has confirmed the
 * transfer — never from the request path before settlement, because a payment
 * that was merely attempted is not revenue and must not appear on screen as if
 * it were.
 */
export function recordPurchase(
  purchase: Omit<Purchase, "id" | "createdAt"> & { id?: string; createdAt?: string },
): Purchase {
  hydrate();
  const row: Purchase = {
    id: purchase.id ?? nextId("pur"),
    endpoint: purchase.endpoint,
    buyerAddr: purchase.buyerAddr,
    amount: purchase.amount,
    token: purchase.token,
    txHash: purchase.txHash,
    createdAt: purchase.createdAt ?? new Date().toISOString(),
  };
  purchaseRows = [row, ...purchaseRows].slice(0, MAX_RETAINED);
  appendRow(PURCHASES, row);
  return row;
}

/**
 * Record a decision about money going out, allowed or not.
 *
 * `orderId` is null for anything that did not reach the exchange — a BLOCK, a
 * REQUIRE_APPROVAL, or an ALLOW whose order then failed. The distinction
 * matters to `spentToday()`, which only counts rows that actually produced an
 * order.
 */
export function recordAction(action: {
  kind: ActionKind;
  payload: Record<string, unknown>;
  decision: Decision["decision"];
  reason: string;
  orderId?: string | null;
}): Action {
  hydrate();
  const row: Action = {
    id: nextId("act"),
    kind: action.kind,
    payload: action.payload,
    decision: action.decision,
    reason: action.reason,
    orderId: action.orderId ?? null,
    createdAt: new Date().toISOString(),
  };
  actionRows = [row, ...actionRows].slice(0, MAX_RETAINED);
  appendRow(ACTIONS, row);
  return row;
}

/**
 * Record what the exchange actually executed.
 *
 * Called from the tick with the order the exchange returned, right after the
 * Action that authorised it. Returns null — and stores nothing — when the order
 * moved no base quantity or no quote value, because a fill without both has no
 * price, and a position built from a priceless fill is a made-up number.
 *
 * That is the honest outcome for a fixture order whose mark could not be read,
 * and it shows on the console as a trade with no position rather than as a
 * position with no profit.
 */
export function recordFill(args: { actionId: string; order: OrderResult }): Fill | null {
  hydrate();
  const { order } = args;
  const qty = Number(order.executedQty);
  const quoteUsd = Number(order.cummulativeQuoteQty);

  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(quoteUsd) || quoteUsd <= 0) return null;

  // Venue, leverage and margin are copied from the order rather than looked up
  // later, so a fill is a complete record of what actually happened even if the
  // leverage setting changes afterwards. See src/lib/types.ts.
  const venue = venueOf(order);
  const leverage = venue === "futures" ? Math.max(1, order.leverage ?? 1) : 1;

  const row: Fill = {
    id: nextId("fil"),
    actionId: args.actionId,
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    qty,
    quoteUsd,
    price: quoteUsd / qty,
    live: order.live,
    venue,
    ...(venue === "futures"
      ? {
          leverage,
          marginUsd: quoteUsd / leverage,
          reduceOnly: order.reduceOnly ?? false,
        }
      : {}),
    createdAt: new Date(order.transactTime || Date.now()).toISOString(),
  };
  fillRows = [row, ...fillRows];
  appendRow(FILLS, row);
  return row;
}

/** Newest first. Every execution, never truncated — see `fillRows`. */
export function fills(limit?: number): Fill[] {
  hydrate();
  return limit === undefined ? [...fillRows] : fillRows.slice(0, limit);
}

/**
 * Has this signal already been traded?
 *
 * Derived from the action rows rather than a separate set, for the same reason
 * `spentToday()` is: one source of truth cannot disagree with itself.
 *
 * The tick needs this because the signal cache holds a row for its whole TTL,
 * so consecutive beats inside that window see the SAME newest signal. Without
 * this check each of them places another order for an idea already acted on —
 * a quiet news hour would re-buy one stale signal until the daily cap was gone.
 * Found live: two beats a minute apart both filled BUY BTCUSDT off one signal.
 *
 * Only rows that reached the exchange count. A signal whose order was refused
 * or failed has not been acted on, and a later beat may legitimately retry it.
 */
export function hasTradedSignal(signalId: string): boolean {
  hydrate();
  return actionRows.some((a) => a.orderId !== null && a.payload?.signalId === signalId);
}

/**
 * Has this signal already been refused by the gate?
 *
 * The companion to `hasTradedSignal()`, and the reason it is a separate
 * question: a BLOCK is a VERDICT on the idea, not a transport failure. The gate
 * is a pure function of the signal and the ledger, so re-running it on the same
 * signal a beat later returns the same answer — re-submitting is work that
 * cannot succeed.
 *
 * Measured on the 2026-09-06..08 run: 138 of 236 actions were repeat blocks of
 * just 17 signals. One $10 BTCUSDT futures idea was refused 58 times over 4h45m
 * against a $50 exchange minimum that was never going to move. Of the 14
 * signals re-submitted at all, exactly one ever filled.
 *
 * Deliberately NOT extended to an ALLOW whose order failed. That is a refusal
 * from Binance, not from us — a timeout or a venue hiccup is transient and a
 * later beat may legitimately retry it. See `hasTradedSignal()`.
 */
export function hasVetoedSignal(signalId: string): boolean {
  hydrate();
  return actionRows.some((a) => a.decision === "BLOCK" && a.payload?.signalId === signalId);
}

/** Newest first. */
export function purchases(limit = 20): Purchase[] {
  hydrate();
  return purchaseRows.slice(0, limit);
}

/** Newest first. */
export function actions(limit = 20): Action[] {
  hydrate();
  return actionRows.slice(0, limit);
}

/**
 * Quote currency committed to trades in the rolling 24h window.
 *
 * The number the budget layer checks against `BUDGET_DAILY_TRADE_USD`. Passed
 * to `evaluateTrade()` by the tick; nothing else should compute it.
 */
export function spentTodayUsd(now = Date.now()): number {
  hydrate();
  return spentToday(actionRows, now);
}

/**
 * Revenue in the same rolling 24h window.
 *
 * Deliberately NOT netted against `spentTodayUsd()`. The two are different
 * rails — USDC on Base Sepolia in, demo USDT out — and a single "profit" figure
 * would imply a settlement between them that does not exist.
 */
export function earnedTodayUsd(now = Date.now()): number {
  hydrate();
  const windowStart = now - 24 * 60 * 60 * 1000;
  return purchaseRows
    .filter((p) => new Date(p.createdAt).getTime() >= windowStart)
    .reduce((total, p) => {
      const amount = Number(p.amount);
      return Number.isFinite(amount) && amount > 0 ? total + amount : total;
    }, 0);
}

export type LedgerSummary = {
  purchaseCount: number;
  actionCount: number;
  /** Trades that reached the exchange. */
  orderCount: number;
  /** Trades the budget layer refused. The leash, counted. */
  blockedCount: number;
  /** Executions on record. Positions are derived from these, not from actions. */
  fillCount: number;
  /** Fills per venue, so the console can label an empty futures panel honestly. */
  spotFillCount: number;
  futuresFillCount: number;
  earnedTodayUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  dailyTradeUsd: number;
};

export function ledgerSummary(now = Date.now()): LedgerSummary {
  hydrate();
  const limits = limitsFromEnv();
  const spent = spentTodayUsd(now);

  return {
    purchaseCount: purchaseRows.length,
    actionCount: actionRows.length,
    orderCount: actionRows.filter((a) => a.orderId !== null).length,
    blockedCount: actionRows.filter((a) => a.decision !== "ALLOW").length,
    fillCount: fillRows.length,
    spotFillCount: fillRows.filter((f) => venueOf(f) === "spot").length,
    futuresFillCount: fillRows.filter((f) => venueOf(f) === "futures").length,
    earnedTodayUsd: earnedTodayUsd(now),
    spentTodayUsd: spent,
    remainingTodayUsd: Math.max(0, limits.dailyTradeUsd - spent),
    dailyTradeUsd: limits.dailyTradeUsd,
  };
}

/**
 * Test hook. Drops every row IN MEMORY and stops this process reading the disk
 * again — it deliberately does not delete the files. A test that wants a clean
 * ledger sets OMON_DATA_DIR to a temp directory, or OMON_PERSIST=0.
 */
export function __resetLedger(): void {
  hydrated = true;
  purchaseRows = [];
  actionRows = [];
  fillRows = [];
  seq = 0;
}
