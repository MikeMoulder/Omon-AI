/**
 * The machine-readable description of what Omon sells.
 *
 * Omon is not listed in any directory — B402 Bazaar indexing is gated on a
 * Binance Pay merchant account, which needs a business entity we do not have
 * (assets/spike-notes.md). Being unlisted is a discovery problem, not a
 * capability problem, so everything a directory would have published is served
 * from the resource itself instead:
 *
 *   GET /.well-known/x402  free, public catalogue of every paid endpoint
 *   GET /api/manifest      the same document, canonical path
 *   402 challenge          carries serviceName, tags and a preview body
 *
 * An agent that is handed the base URL therefore needs nothing else: it can
 * read what is for sale, what shape the data has, what it costs and which chain
 * settles it, then pay — with no signup, no key and no listing in between.
 *
 * This file is the single source of truth. The manifest route and the 402
 * preview both read it, so they can never drift apart.
 */
import type { Intel } from "@/lib/types";

export const SERVICE_NAME = "Omon Intel";

export const SERVICE_DESCRIPTION =
  "Structured, actionable crypto market intelligence and trade signals, priced per call and payable by any x402 client.";

export const SERVICE_TAGS = [
  "crypto",
  "market-intelligence",
  "news",
  "trading-signals",
  "x402",
  "agent-to-agent",
];

/** Shape of one intel row, described for a buyer that has never seen it. */
const INTEL_FIELDS = {
  id: "string — stable row id",
  headline: "string — the source headline",
  sourceUrl: "string — link to the original article",
  summary: "string — two sentences on the mechanism, not a restatement",
  assets: "string[] — ticker symbols, most affected first, max 4",
  direction: '"bullish" | "bearish" | "neutral"',
  confidence: "number — 0..1",
  createdAt: "string — ISO 8601",
} as const;

/**
 * A free taste of the product. Enough for a buyer to decide, not enough to be
 * the product: the two fields the intelligence actually lives in are withheld.
 */
export function previewOf(intel: Intel): Record<string, unknown> {
  return {
    id: intel.id,
    headline: intel.headline,
    sourceUrl: intel.sourceUrl,
    assets: intel.assets,
    direction: intel.direction,
    summary: "[paid] two-sentence mechanism",
    confidence: "[paid] 0..1",
    createdAt: intel.createdAt,
  };
}

export type EndpointDoc = {
  path: string;
  method: "GET";
  status: "live" | "planned";
  description: string;
  query?: Record<string, string>;
  returns: Record<string, unknown>;
};

export const ENDPOINTS: EndpointDoc[] = [
  {
    path: "/api/intel",
    method: "GET",
    status: "live",
    description:
      "Latest structured market intelligence derived from crypto news headlines. Served from a cache refreshed every 5 minutes; each response says how old it is.",
    query: {
      limit: "1-10, default 3 — how many intel rows to return",
    },
    returns: {
      intel: [INTEL_FIELDS],
      fresh: "boolean — false once the cache is past its 5 minute TTL",
      ageSeconds: "number | null — age of the cached rows",
      source: '"cache" | "fixture"',
      servedAt: "string — ISO 8601",
    },
  },
  {
    path: "/api/signals",
    method: "GET",
    status: "planned",
    description:
      "Trade signals derived from the same intelligence plus live Binance prices.",
    returns: {
      signals: [
        {
          symbol: "string — e.g. BNBUSDT",
          side: '"BUY" | "SELL"',
          sizeUsd: "number",
          thesis: "string — one sentence tying the trade to the headline",
          intelId: "string — the intel row this came from",
        },
      ],
    },
  },
];

/**
 * The full catalogue. `baseUrl` comes from the request so the document is
 * correct on localhost and on the deployed origin without configuration.
 */
export function serviceManifest(args: {
  baseUrl: string;
  price: string;
  network: string;
  payTo: string;
  rail: string;
}): Record<string, unknown> {
  return {
    x402Version: 2,
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    tags: SERVICE_TAGS,
    // Said plainly and first. Both money rails here are non-production, and a
    // buyer discovering this service deserves to know before it pays.
    disclosure:
      "Payments settle in test USDC on Base Sepolia via the public x402 facilitator. Not mainnet, and not Binance's B402 rail — B402 merchant onboarding requires a business entity account.",
    payment: {
      protocol: "x402",
      scheme: "exact",
      rail: args.rail,
      network: args.network,
      price: args.price,
      payTo: args.payTo,
      note: "Send an unpaid request to any paid endpoint to receive a 402 challenge with full payment requirements.",
    },
    endpoints: ENDPOINTS.map((e) => ({ ...e, url: `${args.baseUrl}${e.path}` })),
    free: [
      { path: "/.well-known/x402", description: "This document." },
      { path: "/api/manifest", description: "This document, canonical path." },
      { path: "/api/intel/refresh", description: "Cache status (GET)." },
    ],
  };
}
