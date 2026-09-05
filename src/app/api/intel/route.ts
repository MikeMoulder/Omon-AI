/**
 * PAID endpoint. An outside agent gets HTTP 402 with payment requirements,
 * pays, retries, and receives the intel.
 *
 * Serves rows the cache already holds — never generates intel inside a paid
 * request. One model call is 3-15s and a buyer who has already paid must not
 * wait on it. src/lib/intel-cache.ts is filled by the refresh route.
 *
 * Staleness is disclosed, not hidden: `fresh` and `ageSeconds` ride along in the
 * payload so a buyer can decide for itself whether the intelligence is current.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { getIntel, getLatestIntel, revalidateIntel } from "@/lib/intel-cache";
import { previewOf } from "@/lib/service";
import { withPaymentLog } from "@/lib/payment-log";
import { paidRoute, paymentServer } from "@/lib/x402";

export const dynamic = "force-dynamic";

async function handler(request: NextRequest) {
  const limit = Math.min(10, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 3)));
  const { intel, fresh, ageMs, source } = getIntel(limit);

  // Deliberately not awaited. The buyer's response never waits on a model call;
  // this only warms the cache for whoever asks next.
  revalidateIntel();

  return NextResponse.json({
    intel,
    fresh,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    source,
    servedAt: new Date().toISOString(),
  });
}

const server = await paymentServer();

// withPaymentLog wraps the OUTSIDE, because withX402 settles after the handler
// returns and writes the transaction onto the response header. See payment-log.ts.
export const GET = withPaymentLog(
  "/api/intel",
  withX402(
    handler,
    {
      "/api/intel": paidRoute(
        "Structured, actionable crypto market intelligence derived from live news headlines",
        // An unpaid request gets a real row with the two paid fields withheld, so
        // an agent can judge the product before spending anything on it.
        { preview: () => previewOf(getLatestIntel()) },
      ),
    },
    server,
  ),
);
