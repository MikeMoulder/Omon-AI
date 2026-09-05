/**
 * Refresh trigger. Collects news, analyses anything new, fills the cache.
 *
 * Free and unpaid on purpose — this is Omon's own plumbing, not a product. It
 * is the slow path (a model call per new headline), so it lives here rather
 * than inside /api/intel, and a scheduler calls it on an interval.
 *
 * GET reports cache state without doing any work, which is what the console
 * polls. POST does the refresh.
 */
import { NextResponse, type NextRequest } from "next/server";
import { intelCacheStatus, refreshIntel } from "@/lib/intel-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(intelCacheStatus());
}

export async function POST(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("force") === "1";
  const started = Date.now();

  const intel = await refreshIntel({ force });

  return NextResponse.json({
    ok: true,
    forced: force,
    tookMs: Date.now() - started,
    latest: intel[0] ?? null,
    status: intelCacheStatus(),
  });
}
