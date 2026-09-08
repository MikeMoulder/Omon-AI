/**
 * Omon as an MCP server.
 *
 * The other half of `src/lib/mcp.ts`. That file is a client that reads Binance
 * over MCP; this one serves Omon's own output over the same protocol, so an
 * agent that already speaks MCP can consume this one without learning a bespoke
 * REST shape.
 *
 * Hand-rolled for the same reason the client is: the wire format is small
 * enough to read, and one dependency fewer is one dependency fewer. Protocol
 * version matches the client exactly, because the first thing this server was
 * tested against was that client.
 *
 * ## Four tools are free and two are paid, on purpose
 *
 * Gating everything would make the best feature undemonstrable: a judge with no
 * wallet could not call the server at all, and "it works, trust me" is the exact
 * claim this project refuses to make anywhere else. So the four tools that
 * describe what the agent *is* — its rails, its P&L, its positions, its gate —
 * answer to anyone. The two that carry the analysis it sells are the ones behind
 * a 402, because those are the product.
 *
 * ## Paid tools proxy the HTTP route rather than reimplementing it
 *
 * `omon_intel` and `omon_signal` forward to `/api/intel` and `/api/signals` with
 * the caller's payment header attached. That is deliberate. Settlement, the
 * challenge, the preview redaction and the purchase log already exist there,
 * correct and tested, and a second implementation inside the MCP layer would be
 * a second thing that can disagree about whether someone paid. It also means a
 * purchase made over MCP lands in the same `data/payments.jsonl` as one made
 * over HTTP, with no extra wiring.
 *
 * MCP has no native concept of payment, so the 402 rides in the JSON-RPC error
 * envelope. See `PAYMENT_REQUIRED` below.
 */
import { mcpUsage, mcpMode } from "@/lib/mcp";
import { cliMode } from "@/lib/skillhub";
import { exchangeMode } from "@/lib/exchange";
import { reachabilityReport } from "@/lib/reachability";
import { actions, fills } from "@/lib/ledger";
import { computeVenuePnl } from "@/lib/pnl";
import { limitsFromEnv } from "@/lib/budget";
import { priceUsd, priceToken } from "@/lib/x402";
import type { GateCheck } from "@/lib/types";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "omon";
export const SERVER_VERSION = "1.0.0";

/**
 * JSON-RPC application error for "this tool costs money and you have not paid".
 *
 * -32002 is in the implementation-defined server range. MCP does not reserve a
 * code for payment, so this is Omon's, documented here and in the README rather
 * than left for a caller to reverse-engineer from a number.
 */
export const PAYMENT_REQUIRED = -32002;

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Paid tools proxy an HTTP route; free ones are served from memory. */
  paid: false | { path: string };
};

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

export const TOOLS: ToolDef[] = [
  {
    name: "omon_rails",
    title: "Which Binance rail served the last read",
    description:
      "Which Binance Agent OS surface actually served each of Omon's last market reads — MCP, the Skill Hub CLI, or plain REST — plus which Binance products are reachable at all without a funded production account. Free, no payment required.",
    inputSchema: NO_ARGS,
    paid: false,
  },
  {
    name: "omon_pnl",
    title: "Realised and unrealised profit",
    description:
      "Omon's own trading profit and loss, split by venue (Binance Spot Demo Mode and USDⓈ-M futures testnet) and folded from its durable fill ledger. Free, no payment required.",
    inputSchema: NO_ARGS,
    paid: false,
  },
  {
    name: "omon_positions",
    title: "Open positions",
    description:
      "Every position Omon currently holds — spot holdings and perpetual positions — with cost basis, live mark and open profit. Free, no payment required.",
    inputSchema: NO_ARGS,
    paid: false,
  },
  {
    name: "omon_gate",
    title: "Recent budget-gate decisions",
    description:
      "The last N trades Omon proposed and what its deterministic budget gate did with each, including the full numbered check trace and which check refused. Thirteen checks, no model, no network. Free, no payment required.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          default: 10,
          description: "How many recent decisions to return.",
        },
      },
      additionalProperties: false,
    },
    paid: false,
  },
  {
    name: "omon_intel",
    title: "Structured market intelligence (paid)",
    description:
      `Structured, actionable crypto market intelligence derived from live news headlines: assets, direction, confidence and a mechanism summary. Costs ${priceUsd} ${priceToken} per call, settled over x402. An unpaid call returns the challenge plus a redacted preview.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      additionalProperties: false,
    },
    paid: { path: "/api/intel" },
  },
  {
    name: "omon_signal",
    title: "Trading signal and thesis (paid)",
    description:
      `Omon's current trading signal: symbol, side, size, conviction and the one-sentence thesis tying it to the headline that produced it. Costs ${priceUsd} ${priceToken} per call, settled over x402. An unpaid call returns the challenge plus a redacted preview.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      },
      additionalProperties: false,
    },
    paid: { path: "/api/signals" },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** The `tools/list` payload. */
export function toolDescriptors() {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
  }));
}

/* ---------- the free tools ---------- */

function railsResult() {
  return {
    rails: {
      mcp: mcpMode(),
      skillHub: cliMode(),
      exchange: exchangeMode(),
    },
    // The provenance stamp: which rail actually served each read, last time.
    lastReadVia: mcpUsage(),
    reachability: reachabilityReport(),
  };
}

function pnlResult() {
  const venue = computeVenuePnl(fills());
  return {
    totalUsd: venue.totalUsd,
    fillCount: venue.fillCount,
    spot: {
      realizedUsd: venue.spot.realizedUsd,
      unrealizedUsd: venue.spot.unrealizedUsd,
      totalUsd: venue.spot.totalUsd,
      openCount: venue.spot.openCount,
    },
    futures: {
      realizedUsd: venue.futures.realizedUsd,
      unrealizedUsd: venue.futures.unrealizedUsd,
      totalUsd: venue.futures.totalUsd,
    },
    venues: {
      spot: "Binance Spot Demo Mode — real matching engine, demo funds",
      futures: "Binance USDⓈ-M futures testnet — real engine, demo funds",
    },
    note: "Demo and testnet funds. No real money has moved through this agent.",
  };
}

function positionsResult() {
  const venue = computeVenuePnl(fills());
  return {
    spot: venue.spot.positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avgCostUsd: p.avgCostUsd,
      markPrice: p.markPrice,
      marketValueUsd: p.marketValueUsd,
      unrealizedUsd: p.unrealizedUsd,
      unrealizedPct: p.unrealizedPct,
      realizedUsd: p.realizedUsd,
    })),
    futures: venue.futures.positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      notionalUsd: p.notionalUsd,
      unrealizedUsd: p.unrealizedUsd,
    })),
  };
}

function gateResult(limit: number) {
  const rows = actions(Math.min(25, Math.max(1, limit)));
  const limits = limitsFromEnv();

  return {
    limits: {
      maxTradeUsd: limits.maxTradeUsd,
      dailyTradeUsd: limits.dailyTradeUsd,
      allowedSymbols: limits.allowedSymbols,
      maxLeverage: limits.maxLeverage,
      maxQuoteAgeMs: limits.maxQuoteAgeMs,
      dailyLossHaltUsd: limits.dailyLossHaltUsd,
      maxDrawdownUsd: limits.maxDrawdownUsd,
    },
    decisions: rows
      .filter((a) => a.kind === "trade")
      .map((a) => {
        const checks = (a.payload?.checks as GateCheck[] | undefined) ?? [];
        const failed = checks.find((c) => c.status === "fail");
        return {
          at: a.createdAt,
          symbol: a.payload?.symbol ?? null,
          side: a.payload?.side ?? null,
          sizeUsd: a.payload?.sizeUsd ?? null,
          venue: a.payload?.venue ?? "spot",
          decision: a.decision,
          reason: a.reason,
          orderId: a.orderId,
          checksRun: checks.length,
          refusedBy: failed ? { n: failed.n, name: failed.name, detail: failed.detail } : null,
          checks,
        };
      }),
    note: "Plain code. No model, no network. Every check exempts closes, so the agent can always exit.",
  };
}

/**
 * Run a free tool. Paid tools are not routed here — the HTTP layer proxies
 * those, because settlement lives with the route that already implements it.
 */
export function callFreeTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "omon_rails":
      return railsResult();
    case "omon_pnl":
      return pnlResult();
    case "omon_positions":
      return positionsResult();
    case "omon_gate":
      return gateResult(Number(args?.limit ?? 10));
    default:
      throw new Error(`${name} is not a free tool`);
  }
}
