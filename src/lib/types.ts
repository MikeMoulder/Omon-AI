/**
 * Shared types for Omon. Committed before any feature code — every seam,
 * route and component imports from here so the shapes cannot drift.
 */

export type Direction = "bullish" | "bearish" | "neutral";

/** One OHLCV bar. Field names match the ren-ai engine so ported math is comparable. */
export type Candle = {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

/** One story as it came off a feed, before any model has looked at it. */
export type Headline = {
  title: string;
  url: string;
  source: string; // hostname, e.g. "cointelegraph.com"
  snippet: string;
  publishedAt: string; // ISO
};

export type Intel = {
  id: string;
  headline: string;
  sourceUrl: string;
  summary: string;
  assets: string[];
  direction: Direction;
  confidence: number; // 0..1
  createdAt: string; // ISO
};

export type Signal = {
  id: string;
  intelId: string;
  symbol: string; // e.g. "BTCUSDT"
  side: "BUY" | "SELL";
  sizeUsd: number;
  thesis: string;
  createdAt: string; // ISO
  /**
   * How much the news and the chart agreed, -1..1. Optional because a signal can
   * be produced from news alone when there is no candle history; the console
   * must show the difference rather than imply a chart was consulted.
   */
  convictionScore?: number;
  convictionLabel?: "high" | "medium" | "low";
  /** True when news direction and technical regime pointed the same way. */
  aligned?: boolean;
  /** The lines behind the score, for the console and the thesis. */
  convictionReasons?: string[];
};

export type Decision = {
  decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
  reason: string;
  remainingUsd: number;
};

export type Purchase = {
  id: string;
  endpoint: string;
  buyerAddr: string;
  amount: string; // human units, e.g. "0.01"
  token: string; // symbol, e.g. "USDT"
  txHash: string;
  createdAt: string; // ISO
};

export type ActionKind = "trade" | "payout";

export type Action = {
  id: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  decision: Decision["decision"];
  reason: string;
  orderId: string | null;
  createdAt: string; // ISO
};

/** What the exchange gives back after an order. `fills` is empty on a fixture. */
export type OrderResult = {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: string; // FILLED, EXPIRED, ...
  executedQty: string; // base asset actually bought/sold
  cummulativeQuoteQty: string; // quote asset actually spent/received
  transactTime: number;
  live: boolean; // false = fixture, and the console must say so
};

/** One env var read by every seam. Set on the deployed URL before recording. */
export type DemoMode = "fixture" | "auto" | "live";
