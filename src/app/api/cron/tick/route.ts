/**
 * The tick. One beat of the whole system, driven on an interval.
 *
 *   POST /api/cron/tick
 *
 *   1. refreshIntel()   — RSS -> Intel Agent -> intel cache
 *   2. refreshSignals() — newest intel + Binance market data -> Signal Agent
 *   3. evaluateTrade()  — the budget layer decides, in plain code
 *   4. placeOrder()     — only on ALLOW, only through Spot Demo Mode
 *   5. recordAction()   — the verdict is written down either way
 *
 * Step 5 is not bookkeeping, it is the product. A refusal that leaves no trace
 * is indistinguishable from no budget layer at all, so BLOCK is recorded with
 * the same weight as a fill and the console renders both.
 *
 * NEVER call this inside a user-facing request. Two model calls plus market
 * data plus an order is 15-40s. It is a background beat on a 5 minute interval,
 * which matches the cache TTL and keeps the Gemini free tier intact (the quota
 * guard `INTEL_MAX_NEW=3` is what actually bounds it).
 *
 * GET reports the last beat without running one. That is what the console polls
 * and what a scheduler can health-check.
 *
 * Left unauthenticated, like the two refresh routes it drives. The thing worth
 * protecting is not the endpoint, it is the money — and that is protected by
 * src/lib/budget.ts, which cannot be talked out of a limit by anyone who can
 * reach this URL. See `sizeUsd` below for the sharp end of that claim.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { Decision, OrderResult, Signal } from "@/lib/types";
import { evaluateTrade, limitsFromEnv } from "@/lib/budget";
import { placeOrder } from "@/lib/exchange";
import { refreshIntel, intelCacheStatus } from "@/lib/intel-cache";
import { refreshSignals, signalCacheStatus } from "@/lib/signal-cache";
import { ledgerSummary, recordAction, spentTodayUsd } from "@/lib/ledger";

export const dynamic = "force-dynamic";

// Two model calls, candles per symbol and an order. The platform default kills
// a legitimate beat mid-flight; the refresh route it wraps already asks for 60.
export const maxDuration = 120;

export type TickResult = {
  ok: boolean;
  at: string;
  tookMs: number;
  /** Why the beat stopped early, when it did. Null on a beat that reached a verdict. */
  skipped: string | null;
  intel: { rows: number; fresh: boolean; lastError: string | null };
  signal: Signal | null;
  decision: Decision | null;
  order: OrderResult | null;
  orderError: string | null;
};

let lastTick: TickResult | null = null;

export async function GET() {
  return NextResponse.json({
    lastTick,
    ledger: ledgerSummary(),
    limits: limitsFromEnv(),
    intel: intelCacheStatus(),
    signals: signalCacheStatus(),
  });
}

export async function POST(request: NextRequest) {
  const started = Date.now();
  const force = request.nextUrl.searchParams.get("force") === "1";

  /**
   * Demo override for the BLOCKED beat, and a live proof of the claim above.
   *
   * Anyone can put any number here. The budget layer reads it as untrusted
   * input exactly like model output — over the per-trade cap it is refused,
   * under it, it was always within policy. There is no value of this parameter
   * that moves more money than the limits allow, which is the point being
   * demonstrated rather than a hole being left open.
   */
  const sizeOverride = Number(request.nextUrl.searchParams.get("sizeUsd"));

  const finish = (result: Omit<TickResult, "at" | "tookMs">): NextResponse => {
    lastTick = { ...result, at: new Date().toISOString(), tookMs: Date.now() - started };
    return NextResponse.json({ ...lastTick, ledger: ledgerSummary() });
  };

  const intel = await refreshIntel({ force });
  const intelStatus = intelCacheStatus();
  const intelRow = {
    rows: intel.length,
    fresh: intelStatus.fresh,
    lastError: intelStatus.lastError,
  };

  const signals = await refreshSignals({ force });
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

  const sizeUsd = Number.isFinite(sizeOverride) && sizeOverride > 0 ? sizeOverride : signal.sizeUsd;

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
    // The refusal is written down with the reason, and the console shows it.
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
  recordAction({
    kind: "trade",
    payload: order ? { ...payload, status: order.status, live: order.live } : payload,
    decision: decision.decision,
    reason: orderError ? `order failed: ${orderError}` : decision.reason,
    orderId: order?.orderId ?? null,
  });

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
