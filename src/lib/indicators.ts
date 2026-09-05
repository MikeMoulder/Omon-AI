/**
 * Pure technical-indicator math over a candle array. No network, no model, no
 * state — same input, same output, always.
 *
 * Ported from the ren-ai trading agent (github.com/MikeMoulder/ren-ai,
 * backend/src/engine/indicators.js), whose paper log shows a positive
 * expectancy over 42 closed trades. The arithmetic is deliberately identical to
 * the original, including the choices a textbook would argue with — `atr` uses
 * a simple mean of the last `period` true ranges rather than Wilder's
 * smoothing, and `ema` seeds from a simple average of the first `period`
 * values. Those choices are what the recorded edge was measured on, so they are
 * reproduced rather than improved. scripts/indicators-test.ts checks this port
 * against the original implementation on real candle data.
 */
import type { Candle } from "@/lib/types";

/**
 * Exponential moving average. Sparse by design: indices before `period - 1`
 * are undefined, so `out[i]` lines up with `values[i]` and callers can index by
 * candle without an offset.
 */
export function ema(values: number[], period: number): Array<number | undefined> {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: Array<number | undefined> = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Average true range over the last `period` bars. The volatility unit stops are sized in. */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prevClose = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** Relative strength index over the last `period` bars. 50 when there is not enough data. */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Highest high and lowest low over the `len` bars BEFORE index `i`. */
export function priorRange(
  candles: Candle[],
  i: number,
  len: number,
): { high: number; low: number } | null {
  if (i - len < 0 || i > candles.length) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let k = i - len; k < i; k += 1) {
    if (candles[k].h > high) high = candles[k].h;
    if (candles[k].l < low) low = candles[k].l;
  }
  return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
}
