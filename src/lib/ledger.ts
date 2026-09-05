/**
 * The ledger. Every movement of money, in one place, in the order it happened.
 *
 * Two kinds of row and they are not the same thing:
 *
 *   purchases — money IN. An outside agent paid a 402 and got the data.
 *   actions   — money OUT, or refused. Every trade the Signal Agent proposed,
 *               with the budget layer's verdict on it, whether or not an order
 *               was placed.
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
 * Storage is in-process, like src/lib/intel-cache.ts and src/lib/signal-cache.ts,
 * and for the same reasons — it survives across requests on the long-lived VPS
 * process and is lost on a cold start. When a database lands, this file joins
 * those two as the places that change. Until then a restart resets the daily
 * budget window, which is worth knowing before a recording.
 */
import type { Action, ActionKind, Decision, Purchase } from "@/lib/types";
import { limitsFromEnv, spentToday } from "@/lib/budget";

/** Rows kept in memory. The console shows a feed, not an archive. */
const MAX_ROWS = 50;

let purchaseRows: Purchase[] = [];
let actionRows: Action[] = [];

/** Monotonic within a process, so two events in the same millisecond stay distinct. */
let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
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
  const row: Purchase = {
    id: purchase.id ?? nextId("pur"),
    endpoint: purchase.endpoint,
    buyerAddr: purchase.buyerAddr,
    amount: purchase.amount,
    token: purchase.token,
    txHash: purchase.txHash,
    createdAt: purchase.createdAt ?? new Date().toISOString(),
  };
  purchaseRows = [row, ...purchaseRows].slice(0, MAX_ROWS);
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
  const row: Action = {
    id: nextId("act"),
    kind: action.kind,
    payload: action.payload,
    decision: action.decision,
    reason: action.reason,
    orderId: action.orderId ?? null,
    createdAt: new Date().toISOString(),
  };
  actionRows = [row, ...actionRows].slice(0, MAX_ROWS);
  return row;
}

/** Newest first. */
export function purchases(limit = 20): Purchase[] {
  return purchaseRows.slice(0, limit);
}

/** Newest first. */
export function actions(limit = 20): Action[] {
  return actionRows.slice(0, limit);
}

/**
 * Quote currency committed to trades in the rolling 24h window.
 *
 * The number the budget layer checks against `BUDGET_DAILY_TRADE_USD`. Passed
 * to `evaluateTrade()` by the tick; nothing else should compute it.
 */
export function spentTodayUsd(now = Date.now()): number {
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
  earnedTodayUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  dailyTradeUsd: number;
};

export function ledgerSummary(now = Date.now()): LedgerSummary {
  const limits = limitsFromEnv();
  const spent = spentTodayUsd(now);

  return {
    purchaseCount: purchaseRows.length,
    actionCount: actionRows.length,
    orderCount: actionRows.filter((a) => a.orderId !== null).length,
    blockedCount: actionRows.filter((a) => a.decision !== "ALLOW").length,
    earnedTodayUsd: earnedTodayUsd(now),
    spentTodayUsd: spent,
    remainingTodayUsd: Math.max(0, limits.dailyTradeUsd - spent),
    dailyTradeUsd: limits.dailyTradeUsd,
  };
}

/** Test hook. Drops every row. */
export function __resetLedger(): void {
  purchaseRows = [];
  actionRows = [];
  seq = 0;
}
