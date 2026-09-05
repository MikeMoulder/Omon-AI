/**
 * Refresh trigger for the signal cache. Reads the newest intel, pulls candles
 * and prices, asks the Signal Agent, fills the cache.
 *
 * Free and unpaid on purpose — this is Omon's own plumbing, not a product. It
 * is the slow path (candles per symbol plus a model call, 15-40s), so it lives
 * here rather than inside /api/signals, and the tick calls it on an interval.
 * Same shape as /api/intel/refresh so the two are driven identically.
 *
 * GET reports cache state without doing any work, which is what the console
 * polls. POST does the refresh.
 */
import { NextResponse, type NextRequest } from "next/server";
import { refreshSignals, signalCacheStatus } from "@/lib/signal-cache";

export const dynamic = "force-dynamic";

// The refresh can outrun the platform default. Two market-data pulls plus a
// model call is 15-40s; anything shorter kills a legitimate run mid-flight.
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json(signalCacheStatus());
}

export async function POST(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("force") === "1";
  const started = Date.now();

  const signals = await refreshSignals({ force });

  return NextResponse.json({
    ok: true,
    forced: force,
    tookMs: Date.now() - started,
    latest: signals[0] ?? null,
    status: signalCacheStatus(),
  });
}
