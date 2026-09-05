/**
 * Turns a settled 402 into a ledger row.
 *
 * `withX402` settles AFTER the wrapped handler returns and writes the result
 * onto the response as a `PAYMENT-RESPONSE` header — so the handler itself
 * cannot see the transaction hash, and neither can the `preview` callback,
 * which unpaid traffic reaches instead. The only place the settled fact exists
 * is on the way out.
 *
 * So this wraps the OTHER way round: outside `withX402`, reading the header off
 * the finished response. Nothing about the paid path changes, which matters —
 * /api/intel works and is not worth refactoring for a display feature.
 *
 * Only successful settlements are recorded. A failed or absent settlement is
 * not revenue and must never appear on the console as if it were.
 */
import type { NextRequest, NextResponse } from "next/server";
import { recordPurchase } from "@/lib/ledger";
import { priceToken, priceUsd } from "@/lib/x402";

type Handler = (request: NextRequest) => Promise<NextResponse<unknown>>;

/** Set by @x402/core's `createSettlementHeaders`. Not the v1 `X-PAYMENT-RESPONSE`. */
const SETTLEMENT_HEADER = "PAYMENT-RESPONSE";

/** The buyer-facing subset of x402's SettleResponse. Everything is optional by design. */
type SettleResponse = {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  amount?: string;
  errorReason?: string;
  errorMessage?: string;
};

/**
 * The header is base64 of JSON. x402 encodes it URL-safely, so undo that before
 * decoding — a `-` or `_` left in place yields bytes that fail JSON.parse and
 * would silently drop a real payment from the ledger.
 */
function decodeSettlement(raw: string): SettleResponse | null {
  try {
    const normalised = raw.replace(/-/g, "+").replace(/_/g, "/");
    const parsed: unknown = JSON.parse(Buffer.from(normalised, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as SettleResponse) : null;
  } catch {
    return null;
  }
}

/**
 * What the buyer paid, in human units.
 *
 * `amount` comes back in the asset's atomic units and the settle response does
 * not carry its decimals, so a conversion here would be a guess. The configured
 * price is not a guess — it is the exact figure the 402 challenge demanded and
 * the facilitator matched against — so that is what the ledger records. The
 * atomic figure is kept alongside it only when it disagrees with nothing.
 */
function humanAmount(): string {
  return priceUsd.toFixed(Math.max(2, (String(priceUsd).split(".")[1] ?? "").length));
}

/**
 * Wrap a route already wrapped by `withX402`. Order matters:
 *
 *   export const GET = withPaymentLog("/api/intel", withX402(handler, routes, server));
 *
 * The other way round would read the header before settlement had written it.
 */
export function withPaymentLog(endpoint: string, handler: Handler): Handler {
  return async (request: NextRequest) => {
    const response = await handler(request);

    try {
      const raw = response.headers.get(SETTLEMENT_HEADER);
      if (!raw) return response;

      const settled = decodeSettlement(raw);
      // `success` absent is treated as failure on purpose: an unparseable or
      // ambiguous settlement is not something to show as money received.
      if (!settled?.success) return response;

      recordPurchase({
        endpoint,
        buyerAddr: settled.payer ?? "unknown",
        amount: humanAmount(),
        token: priceToken,
        txHash: settled.transaction ?? "",
      });
    } catch (err) {
      // A display feature must never break a paid response the buyer has
      // already been charged for.
      console.warn("[payment-log] could not record settlement:", err);
    }

    return response;
  };
}
