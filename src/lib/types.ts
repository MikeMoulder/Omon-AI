/**
 * Shared types for Omon. Committed before any feature code — every seam,
 * route and component imports from here so the shapes cannot drift.
 */

export type Direction = "bullish" | "bearish" | "neutral";

/**
 * Which market an order goes to, and the single most load-bearing field added
 * in the futures work.
 *
 * Spot and futures are not two flavours of the same trade. On spot, notional is
 * risk and a position can only be long. On futures the position is signed, the
 * margin posted is notional/leverage, and the P&L arithmetic is entirely
 * different (see src/lib/pnl.ts). Every row that can reach an exchange carries
 * this so nothing downstream has to guess which set of rules applies.
 *
 * Optional on the stored shapes rather than required, because `data/*.jsonl`
 * already holds rows written before futures existed. `venueOf()` reads those as
 * spot, which is what they were.
 */
export type Venue = "spot" | "futures";

/** A row's venue, defaulting pre-futures rows to the venue they were written on. */
export function venueOf(row: { venue?: Venue } | null | undefined): Venue {
  return row?.venue === "futures" ? "futures" : "spot";
}

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
  /**
   * Position size in quote currency (USDT).
   *
   * On spot this is what gets spent. On futures it is NOTIONAL, not margin —
   * the exposure the position carries. The budget layer checks this number on
   * both venues so one cap means one thing, and margin is derived from it.
   */
  sizeUsd: number;
  /** Which market this idea is for. Absent on rows written before futures. */
  venue?: Venue;
  /** Futures only. 1 on spot, where there is no borrowing. */
  leverage?: number;
  /** Futures only. True when the order may only shrink an open position. */
  reduceOnly?: boolean;
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
  venue?: Venue;
  /** Futures only. What leverage the position was actually opened at. */
  leverage?: number;
  reduceOnly?: boolean;
};

/** One env var read by every seam. Set on the deployed URL before recording. */
export type DemoMode = "fixture" | "auto" | "live";

/**
 * One execution, as the exchange reported it.
 *
 * Distinct from `Action`, and both are needed: an Action is what the budget
 * layer *decided*, a Fill is what the market actually *did*. A BLOCK produces an
 * Action and no Fill; an ALLOW whose order errored produces an Action and no
 * Fill. Only Fills carry a price, and only prices make P&L possible.
 */
export type Fill = {
  id: string;
  /** The Action this execution came from, so the console can join the two. */
  actionId: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  /** Base asset actually filled, e.g. BTC. */
  qty: number;
  /** Quote asset actually moved, USDT. */
  quoteUsd: number;
  /** quoteUsd / qty — the average price this fill got. */
  price: number;
  /** false = fixture. The console must never show a fixture fill as a real one. */
  live: boolean;
  /** Which market executed this. Absent on rows written before futures existed. */
  venue?: Venue;
  /** Futures only. Needed to say what this position actually tied up. */
  leverage?: number;
  /**
   * Futures only. Margin posted for this fill, `quoteUsd / leverage`.
   *
   * Stored rather than derived so a later leverage change cannot retroactively
   * rewrite what an old fill cost.
   */
  marginUsd?: number;
  reduceOnly?: boolean;
  createdAt: string; // ISO
};
