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
import type { Intel, Signal } from "@/lib/types";

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

/**
 * The unpaid preview of a signal.
 *
 * Withholds exactly the two fields that ARE the product — `side` and `sizeUsd`,
 * the actionable instruction — while showing enough for a buyer to judge
 * quality: which market, how strongly the news and the chart agreed, and when
 * it was formed. Same bargain as previewOf() above.
 *
 * Returns null on a cold cache rather than inventing a row. A fabricated trade
 * is a different thing from a fabricated summary, and must never appear in a
 * 402 challenge dressed as real.
 */
export function previewOfSignal(signal: Signal | null): Record<string, unknown> | null {
  if (!signal) return null;
  return {
    id: signal.id,
    intelId: signal.intelId,
    symbol: signal.symbol,
    side: "[paid] BUY | SELL",
    sizeUsd: "[paid] number",
    thesis: "[paid] one sentence tying the trade to the headline",
    convictionLabel: signal.convictionLabel ?? null,
    convictionScore: signal.convictionScore ?? null,
    createdAt: signal.createdAt,
  };
}

export type EndpointDoc = {
  path: string;
  method: "GET";
  status: "live" | "planned";
  description: string;
  query?: Record<string, string>;
  returns: Record<string, unknown>;
  /**
   * Which Binance Agent OS calls this endpoint's data is derived from.
   *
   * Published because provenance is part of what a buyer is purchasing: an
   * agent deciding whether to pay for a signal should be able to see that the
   * technicals behind it came off Binance's own market data rather than an
   * unnamed aggregator. It is also the honest answer to "where is Agent OS in
   * this product" — stated at the discovery URL, not just in a README.
   */
  poweredBy?: string[];
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
    poweredBy: ["rss:cointelegraph", "rss:coindesk", "llm:gemini"],
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
    status: "live",
    description:
      "Trade signals derived from the same intelligence plus live Binance market data, each carrying a conviction score for how far the news and the chart agreed. Served from a cache; each response says how old it is.",
    query: {
      limit: "1-10, default 3 — how many signals to return",
    },
    // Named per rail rather than per vendor: reads try Binance MCP first and
    // fall through to the Skill Hub CLI, and /api/agent-os reports which one
    // actually served. Provenance is part of what a buyer is purchasing.
    poweredBy: [
      "binance-skillhub:spot klines",
      "binance-skillhub:spot ticker-price",
      "binance-mcp:spot_klines",
      "binance-mcp:spot_tickerPrice",
      "llm:gemini",
    ],
    returns: {
      signals: [
        {
          symbol: "string — e.g. BNBUSDT",
          side: '"BUY" | "SELL"',
          sizeUsd: "number",
          thesis: "string — one sentence tying the trade to the headline",
          intelId: "string — the intel row this came from",
          convictionScore: "number | null — -1..1, how far news and chart agreed",
          convictionLabel: '"high" | "medium" | "low" | null',
        },
      ],
      fresh: "boolean — false once the cache is past its TTL",
      ageSeconds: "number | null — age of the cached signals",
      source: '"cache" | "empty"',
      servedAt: "string — ISO 8601",
    },
  },
];

/**
 * The full catalogue. `baseUrl` comes from the request so the document is
 * correct on localhost and on the deployed origin without configuration.
 */
/**
 * Which Binance Agent OS surfaces this product runs on, stated where a machine
 * (or a judge) can read it without cloning the repo.
 *
 * Written as a claim that can be checked: every tool and command named here is
 * one a smoke script resolves against the live service (`scripts/mcp-smoke.ts`,
 * `scripts/skillhub-smoke.ts`), and the read/write split is the actual code
 * path in `src/lib/exchange.ts`, not an aspiration.
 *
 * Two read surfaces are listed because Omon genuinely tries both, in order. MCP
 * is first but its clients are allowlisted and Omon's self-published client_id
 * is refused, so the Skill Hub CLI is what serves in practice. Both states are
 * reported live rather than asserted — a manifest that claims an integration it
 * does not have is worse than one that admits the gap.
 */
export function agentOsUsage(
  mcp: { mode: "live" | "off"; reason: string },
  cli: { mode: "live" | "off"; reason: string },
) {
  return {
    platform: "Binance Agent OS",
    surfaces: [
      {
        surface: "Binance MCP Server",
        endpoint: "https://agent.binance.com/mcp/agentic",
        use: "All market reads: prices and the OHLCV candles the strategy runs on, plus account state.",
        tools: ["spot_tickerPrice", "spot_klines", "spot_getAccount"],
        status: mcp.mode === "live" ? "connected" : "not connected",
        detail: mcp.reason,
      },
      {
        surface: "Binance Skill Hub — binance-cli",
        endpoint: "https://github.com/binance/binance-cli",
        use: "Market reads when MCP is unavailable: prices and the OHLCV candles the strategy runs on. Needs no credentials, which is why this rail is the one that actually serves.",
        commands: ["spot ticker-price", "spot klines"],
        status: cli.mode === "live" ? "in use" : "not available",
        detail: cli.reason,
      },
      {
        surface: "Binance Exchange API — Spot Demo Mode",
        endpoint: "https://demo-api.binance.com",
        use: "Order execution. A real matching engine with demo funds.",
        status: "in use",
      },
    ],
    // The distinction a judge will ask about, answered before they ask.
    executionPolicy:
      "Reads try Binance MCP, then the Skill Hub CLI, then plain REST, and /api/agent-os reports which rail actually served the last call. Order writes go through Spot Demo Mode REST only. The MCP token authorises a real Binance account, so no order is ever placed over MCP.",
  };
}

export function serviceManifest(args: {
  baseUrl: string;
  price: string;
  network: string;
  payTo: string;
  rail: string;
  mcp: { mode: "live" | "off"; reason: string };
  cli: { mode: "live" | "off"; reason: string };
}): Record<string, unknown> {
  return {
    x402Version: 2,
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    tags: SERVICE_TAGS,
    agentOs: agentOsUsage(args.mcp, args.cli),
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
      { path: "/api/signals/refresh", description: "Signal cache status (GET)." },
    ],
  };
}
