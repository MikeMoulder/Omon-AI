/**
 * Free, public: the live state of Omon's Binance OnchainPay (B402) rail.
 *
 *   GET /api/b402
 *
 * The companion to /api/agent-os, and written for the same reason. "We support
 * B402, we just do not have merchant access yet" is a claim a reader has no way
 * to check — it reads identically whether the mapping is finished or was never
 * written. This endpoint turns it into a report: the exact payment challenge
 * Omon would issue on BNB Smart Chain, built by the same `b402Accepts()` the
 * live rail calls, next to the named environment variables that are still unset
 * and the one handshake Binance still has to grant.
 *
 * No credential is ever returned. `missing` and `present` carry variable NAMES
 * and nothing else, which is what makes this safe to serve publicly and to put
 * on screen in a demo.
 *
 * Never behind a 402: a rail you cannot inspect is a rail nobody will adopt.
 */
import { NextResponse } from "next/server";
import { b402Report, rail, settlementRail } from "@/lib/x402";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = b402Report();

  return NextResponse.json(
    {
      b402: report,
      // Stated separately and in plain English, because the JSON above is for
      // machines and this line is the one a person reads first.
      summary:
        settlementRail === "b402"
          ? "B402 is live. Paid endpoints settle on BNB Smart Chain via Binance OnchainPay."
          : rail === "b402-preview"
            ? "B402 is mapped and published but NOT settling. Paid endpoints settle on the public " +
              "x402 facilitator (Base Sepolia). `wouldAdvertise` is the real challenge this service " +
              "issues the moment merchant credentials land — flip X402_RAIL=b402 and nothing else changes."
            : "B402 is not the selected rail. Set X402_RAIL=b402-preview to publish the mapping, or " +
              "X402_RAIL=b402 with merchant credentials to settle on BNB Smart Chain.",
      servedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
