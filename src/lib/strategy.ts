/**
 * The technical half of the Signal Agent. Plain code, no model.
 *
 * Ported from the trend-breakout strategy in github.com/MikeMoulder/ren-ai:
 * trade with the higher trend (EMA fast over EMA slow), enter when price breaks
 * the N-bar extreme, size risk in ATR. That agent's paper log shows a positive
 * expectancy (+$16/trade over 42 closed trades) and — the reason this file
 * exists — every dollar of it came from trades where news sentiment AGREED with
 * the technical direction. Breakouts taken with neutral sentiment lost money.
 * The sample is small enough that this is a design lead rather than a proven
 * law, but it points the same way as the strategy's own thesis.
 *
 * TWO DELIBERATE DEPARTURES from the original, both forced by what Omon is:
 *
 * 1. The breakout is ADVISORY, not a gate. A 10-bar breakout on hourly candles
 *    fires perhaps once a week per symbol; gating on it would mean a demo that
 *    shows nothing. Instead the full technical picture is scored and handed to
 *    the model, which always produces a signal — but one that can cite where
 *    price actually sits. A real breakout raises conviction rather than being
 *    the price of entry.
 *
 * 2. No shorts, no trailing stops. Omon trades Binance SPOT, where selling
 *    needs the asset already in hand, and a trailing stop needs a position
 *    monitor and durable storage that do not exist yet. Bearish conviction
 *    therefore means "do not buy", not "sell". The ren-ai log happens to agree:
 *    its shorts lost $284 while its longs made $957.
 */
import type { Candle, Direction, Intel } from "@/lib/types";
import { atr, ema, priorRange, rsi } from "@/lib/indicators";

export const STRATEGY_DEFAULTS = {
  emaFast: 50,
  emaSlow: 200,
  breakoutLen: 10,
  atrPeriod: 14,
  rsiPeriod: 14,
};

export type Regime = "up" | "down" | "flat";

export type TechnicalSnapshot = {
  symbol: string;
  interval: string;
  price: number;
  emaFast: number;
  emaSlow: number;
  regime: Regime;
  /** How far price sits above the slow EMA, in percent. Signed. */
  trendStrengthPct: number;
  atr: number;
  /** ATR as a percent of price — the honest way to compare volatility across assets. */
  atrPct: number;
  rsi: number;
  breakoutHigh: number;
  breakoutLow: number;
  /** Distance to the breakout level, percent. Negative means price is already through it. */
  toBreakoutHighPct: number;
  toBreakoutLowPct: number;
  /** A breakout that actually fired on the last closed candle, per the original rules. */
  breakout: "long" | "short" | null;
  bars: number;
};

/**
 * The original `trendSignal`, unchanged in behaviour: a breakout only counts
 * when it agrees with the EMA trend. Evaluated on the last CLOSED candle.
 */
export function trendSignal(
  candles: Candle[],
  i: number,
  opts: Partial<typeof STRATEGY_DEFAULTS> = {},
): { active: boolean; side?: "long" | "short"; atr?: number } {
  const o = { ...STRATEGY_DEFAULTS, ...opts };
  if (i < o.emaSlow || i < o.breakoutLen || i >= candles.length) return { active: false };

  const closes = candles.map((c) => c.c);
  const fast = ema(closes, o.emaFast)[i];
  const slow = ema(closes, o.emaSlow)[i];
  if (fast == null || slow == null) return { active: false };

  const a = atr(candles.slice(0, i + 1), o.atrPeriod);
  if (!a) return { active: false };

  const range = priorRange(candles, i, o.breakoutLen);
  if (!range) return { active: false };

  const c = candles[i];
  if (fast > slow && c.c > range.high) return { active: true, side: "long", atr: a };
  if (fast < slow && c.c < range.low) return { active: true, side: "short", atr: a };
  return { active: false };
}

const pct = (from: number, to: number) => ((to - from) / from) * 100;

/**
 * Everything the model should know about where price actually is. Returns null
 * when there is not enough history to say anything honest — a short candle
 * series must produce no snapshot rather than a confident-looking wrong one.
 */
export function technicalSnapshot(args: {
  symbol: string;
  interval: string;
  candles: Candle[];
  opts?: Partial<typeof STRATEGY_DEFAULTS>;
}): TechnicalSnapshot | null {
  const o = { ...STRATEGY_DEFAULTS, ...args.opts };
  const candles = args.candles;
  if (candles.length < o.emaSlow + 1) return null;

  const i = candles.length - 1;
  const closes = candles.map((c) => c.c);
  const fast = ema(closes, o.emaFast)[i];
  const slow = ema(closes, o.emaSlow)[i];
  const range = priorRange(candles, i, o.breakoutLen);
  if (fast == null || slow == null || !range) return null;

  const price = closes[i];
  const a = atr(candles, o.atrPeriod);
  const signal = trendSignal(candles, i, o);

  // "flat" is a real answer. A 0.1% gap between the EMAs is noise, and calling
  // it a trend is how a strategy talks itself into a trade it should not take.
  const gapPct = pct(slow, fast);
  const regime: Regime = gapPct > 0.1 ? "up" : gapPct < -0.1 ? "down" : "flat";

  return {
    symbol: args.symbol,
    interval: args.interval,
    price,
    emaFast: fast,
    emaSlow: slow,
    regime,
    trendStrengthPct: pct(slow, price),
    atr: a,
    atrPct: price > 0 ? (a / price) * 100 : 0,
    rsi: rsi(closes, o.rsiPeriod),
    breakoutHigh: range.high,
    breakoutLow: range.low,
    toBreakoutHighPct: pct(price, range.high),
    toBreakoutLowPct: pct(price, range.low),
    breakout: signal.active ? (signal.side as "long" | "short") : null,
    bars: candles.length,
  };
}

export type Conviction = {
  /** -1 (strong bearish agreement) .. +1 (strong bullish agreement). */
  score: number;
  label: "high" | "medium" | "low";
  /** Do the news and the chart point the same way? The thing that mattered in the log. */
  aligned: boolean;
  newsScore: number;
  techScore: number;
  /** Plain-English lines the console and the thesis can quote verbatim. */
  reasons: string[];
};

/** Intel direction and confidence collapsed to one signed number in -1..1. */
export function newsScore(direction: Direction, confidence: number): number {
  const c = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  if (direction === "bullish") return c;
  if (direction === "bearish") return -c;
  return 0;
}

/** Regime and breakout collapsed to one signed number in -1..1. */
export function techScore(snap: TechnicalSnapshot): number {
  let s = snap.regime === "up" ? 0.4 : snap.regime === "down" ? -0.4 : 0;
  if (snap.breakout === "long") s += 0.4;
  if (snap.breakout === "short") s -= 0.4;
  // Trend strength nudges, capped so it can never outvote the regime itself.
  s += Math.max(-0.2, Math.min(0.2, snap.trendStrengthPct / 50));
  return Math.max(-1, Math.min(1, s));
}

/**
 * Blend the two halves. `aligned` is the field that earned its place: in the
 * ren-ai log, breakouts taken with agreeing sentiment returned +$1,444 over 26
 * trades while those taken on neutral sentiment lost $1,181 over 11.
 */
export function conviction(args: {
  intel: Pick<Intel, "direction" | "confidence">;
  snapshot: TechnicalSnapshot | null;
}): Conviction {
  const news = newsScore(args.intel.direction, args.intel.confidence);
  const tech = args.snapshot ? techScore(args.snapshot) : 0;
  const reasons: string[] = [];

  // Both halves must be meaningfully non-zero to count as agreement. Without
  // this floor, "flat chart plus neutral news" would score as perfect alignment.
  const aligned =
    Math.abs(news) > 0.1 && Math.abs(tech) > 0.1 && Math.sign(news) === Math.sign(tech);

  // Agreement is worth more than either half alone — that is the whole finding —
  // so an aligned pair is scored above its own average.
  const base = (news + tech) / 2;
  const score = Math.max(-1, Math.min(1, aligned ? base * 1.3 : base * 0.7));

  reasons.push(
    `news ${news >= 0 ? "+" : ""}${news.toFixed(2)} (${args.intel.direction} @ ${args.intel.confidence.toFixed(2)})`,
  );

  if (args.snapshot) {
    const s = args.snapshot;
    reasons.push(
      `chart ${tech >= 0 ? "+" : ""}${tech.toFixed(2)} (${s.regime} regime, price ${s.trendStrengthPct >= 0 ? "+" : ""}${s.trendStrengthPct.toFixed(1)}% vs EMA${STRATEGY_DEFAULTS.emaSlow})`,
    );
    reasons.push(
      s.breakout
        ? `${s.breakout} breakout fired on the last ${s.interval} candle`
        : `no breakout — ${Math.abs(s.toBreakoutHighPct).toFixed(1)}% below the ${STRATEGY_DEFAULTS.breakoutLen}-bar high`,
    );
    reasons.push(`volatility ${s.atrPct.toFixed(2)}% ATR, RSI ${s.rsi.toFixed(0)}`);
  } else {
    reasons.push("chart 0.00 (no candle history — news only)");
  }

  reasons.push(aligned ? "news and chart AGREE" : "news and chart do not agree");

  const abs = Math.abs(score);
  return {
    score,
    label: aligned && abs >= 0.5 ? "high" : abs >= 0.25 ? "medium" : "low",
    aligned,
    newsScore: news,
    techScore: tech,
    reasons,
  };
}
