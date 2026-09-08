/**
 * PAID endpoint. An outside agent gets HTTP 402 with payment requirements,
 * pays, retries, and receives the trade signals.
 *
 * The second half of Omon's paid catalogue: /api/intel sells what the news
 * means, this sells what to do about it. `/.well-known/x402` has advertised
 * this path since the manifest was written — it 404'd until 2026-09-05, which
 * meant an agent following Omon's own discovery document hit a dead link.
 *
 * Serves rows the cache already holds — never generates a signal inside a paid
 * request. One signal is a candle fetch per symbol plus a model call, 15-40s
 * end to end, and a buyer who has already paid must not wait on it.
 * src/lib/signal-cache.ts is filled by the tick, and revalidated in the
 * background here.
 *
 * Staleness is disclosed, not hidden: `fresh` and `ageSeconds` ride along so a
 * buyer can decide for itself whether a signal is still actionable — which
 * matters more here than for intel, because a trade idea decays faster than a
 * summary of why it exists.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { getLatestSignal, getSignals, revalidateSignals } from "@/lib/signal-cache";
import { previewOfSignal } from "@/lib/service";
import { withPaymentLog } from "@/lib/payment-log";
import { paidRoute, paymentServer, withPublicOrigin } from "@/lib/x402";

export const dynamic = "force-dynamic";

async function handler(request: NextRequest) {
  const limit = Math.min(10, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 3)));
  const { signals, fresh, ageMs, source } = getSignals(limit);

  // Deliberately not awaited. The buyer's response never waits on a model call;
  // this only warms the cache for whoever asks next.
  revalidateSignals();

  return NextResponse.json({
    signals,
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
  "/api/signals",
  // withPublicOrigin sits between the two: the challenge x402 builds must name
  // the origin a buyer reaches, not the loopback port Next is bound to.
  withPublicOrigin(
    withX402(
      handler,
      {
        "/api/signals": paidRoute(
          "Trade signals derived from live news intelligence plus Binance market data, with a stated conviction score",
          // An unpaid request gets a real row with the actionable fields withheld,
          // so an agent can judge the product before spending anything on it. The
          // side and size are the product; the symbol and reasoning are the shop
          // window.
          {
            preview: () => {
              // Warm the cache from unpaid traffic too. withX402 answers an unpaid
              // request from here and never reaches `handler`, so revalidating only
              // there would leave the preview permanently null until the tick runs
              // — the first agent to discover Omon would see an empty shop window.
              // Bounded by the same TTL and single-flight guard as every other
              // caller, so discovery traffic cannot burn the model quota.
              revalidateSignals();
              return previewOfSignal(getLatestSignal());
            },
          },
        ),
      },
      server,
    ),
  ),
);
