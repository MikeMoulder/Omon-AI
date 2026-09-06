/**
 * The tick, over HTTP.
 *
 *   POST /api/cron/tick            one beat
 *   POST /api/cron/tick?force=1    ignore cache freshness
 *   POST /api/cron/tick?sizeUsd=99 propose a size (see below)
 *   GET  /api/cron/tick            the last beat, without running one
 *
 * The beat itself lives in src/lib/tick.ts because the scheduler drives the
 * same code on an interval — this route is a manual handle on it, not a second
 * implementation. Normally nobody needs to call this at all.
 *
 * NEVER call it inside a user-facing request: two model calls plus market data
 * plus an order is 15-40s.
 *
 * Left unauthenticated, like the two refresh routes it wraps. The thing worth
 * protecting is not the endpoint, it is the money — and that is protected by
 * src/lib/budget.ts, which cannot be talked out of a limit by anyone who can
 * reach this URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { limitsFromEnv } from "@/lib/budget";
import { intelCacheStatus } from "@/lib/intel-cache";
import { signalCacheStatus } from "@/lib/signal-cache";
import { ledgerSummary } from "@/lib/ledger";
import { schedulerStatus } from "@/lib/scheduler";
import { lastTick, runTick } from "@/lib/tick";

export const dynamic = "force-dynamic";

// Two model calls, candles per symbol and an order. The platform default kills
// a legitimate beat mid-flight.
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json({
    lastTick: lastTick(),
    scheduler: schedulerStatus(),
    ledger: ledgerSummary(),
    limits: limitsFromEnv(),
    intel: intelCacheStatus(),
    signals: signalCacheStatus(),
  });
}

export async function POST(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("force") === "1";

  /**
   * Demo override for the BLOCKED beat, and a live proof of the budget layer's
   * central claim.
   *
   * Anyone can put any number here. It is read as untrusted input exactly like
   * model output — over the per-trade cap it is refused, under it, it was
   * always within policy. There is no value of this parameter that moves more
   * money than the limits allow, which is the point being demonstrated rather
   * than a hole being left open.
   */
  const raw = request.nextUrl.searchParams.get("sizeUsd");
  const sizeUsd = raw === null ? undefined : Number(raw);

  // The heartbeat marks itself so the console can say "automatic" honestly
  // rather than reporting scheduled work as a click. A header, not a query
  // param, so it cannot be set by following a link. It is a label only —
  // nothing about the beat's behaviour depends on it.
  const source = request.headers.get("x-omon-heartbeat") === "1" ? "schedule" : "manual";

  const result = await runTick({ force, sizeUsd, source });

  return NextResponse.json({ ...result, ledger: ledgerSummary() });
}
