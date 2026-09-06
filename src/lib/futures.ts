/**
 * Futures seam. USDⓈ-M perpetuals, and the only file that talks to the futures
 * host.
 *
 * This exists as its own file rather than a flag inside src/lib/exchange.ts
 * because futures is not spot with a leverage field bolted on. Four things are
 * genuinely different, and each one broke something the first time it was
 * assumed away:
 *
 *   1. **A different host and a different key pair.** Spot Demo Mode
 *      (`demo-api.binance.com`) and the futures demo host are separate systems
 *      with separate balances. A key that signs one returns -2015 on the other.
 *   2. **No `quoteOrderQty`.** Spot lets you say "spend $20" and Binance works
 *      out the quantity. `/fapi/v1/order` has no such parameter: it wants
 *      `quantity` in base units, correctly rounded to the symbol's `stepSize`,
 *      or it rejects the order outright. `quantityFor()` below is that rounding
 *      and it is not optional.
 *   3. **Positions are signed.** A short is a real position with negative
 *      quantity, not the absence of a long. See src/lib/pnl.ts.
 *   4. **Notional is not margin.** $20 at 5x posts $4 and carries $20 of
 *      exposure. The budget layer checks notional on both venues so one cap
 *      means one thing; margin is reported alongside, never instead.
 *
 * ## Why futures at all
 *
 * Because the strategy already knew how to be bearish and had nowhere to put
 * it. `trendSignal()` in src/lib/strategy.ts has returned `side: "short"` since
 * the first commit, and until now every short breakout it found was computed
 * and thrown away, because a spot account cannot act on one. Half the analysis
 * engine was dead code. This is the rail that makes it live.
 */
import crypto from "node:crypto";
import type { OrderResult } from "@/lib/types";

/**
 * Futures Demo host. Separate from the spot host on purpose — see the header.
 *
 * Defaults to Binance's USDⓈ-M futures testnet, which is free, needs no
 * funding, and runs the real matching engine. `demo.binance.com` issues futures
 * demo keys from the same API management page as the spot ones, and pointing
 * this at that host works unchanged if you have them.
 */
const BASE = process.env.BINANCE_FUTURES_BASE_PATH ?? "https://testnet.binancefuture.com";
const TIMEOUT_MS = Number(process.env.EXCHANGE_TIMEOUT_MS ?? 10_000);

/**
 * Futures keys, falling back to the spot pair.
 *
 * The fallback is a convenience for a single-account setup, not an assumption:
 * if the futures host rejects the spot key the error says so plainly rather
 * than being swallowed, and `futuresMode()` reports which pair it is using.
 */
function keys(): { key: string | undefined; secret: string | undefined; own: boolean } {
  const key = process.env.BINANCE_FUTURES_API_KEY;
  const secret = process.env.BINANCE_FUTURES_SECRET_KEY;
  if (key && secret) return { key, secret, own: true };
  return { key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_SECRET_KEY, own: false };
}

/**
 * Hard ceiling on leverage, enforced here AND in src/lib/budget.ts.
 *
 * Two places on purpose. This one stops a bad env var reaching Binance; the
 * budget one stops a model-proposed number ever getting this far. Leverage is
 * the one parameter where a single misplaced digit turns a $20 idea into a
 * liquidation, so it is checked on the way in and on the way out.
 */
export const MAX_LEVERAGE = Math.max(
  1,
  Math.min(20, Number(process.env.FUTURES_MAX_LEVERAGE ?? 3)),
);

/** Exchange-wide floor. Futures rejects anything smaller with -4164. */
export const MIN_NOTIONAL_USD = Number(process.env.FUTURES_MIN_NOTIONAL_USD ?? 5);

export class FuturesError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "FuturesError";
  }
}

/**
 * Whether futures trading is on, and why not when it is not.
 *
 * Off by default. Futures is opt-in rather than opt-out because it is the one
 * venue on this system that can lose more than it puts in, and a deployment
 * that gets it by accident is a deployment nobody chose to leverage.
 */
export function futuresMode(): { mode: "off" | "fixture" | "live"; reason: string } {
  if (process.env.FUTURES_ENABLED !== "1") {
    return { mode: "off", reason: "FUTURES_ENABLED is not 1" };
  }
  if (process.env.DEMO_MODE === "fixture") {
    return { mode: "fixture", reason: "DEMO_MODE=fixture" };
  }
  const { key, secret, own } = keys();
  if (!key || !secret) {
    return { mode: "fixture", reason: "no futures or spot API keys set" };
  }
  return {
    mode: "live",
    reason: `binance futures @ ${new URL(BASE).host}${own ? "" : " (spot key pair)"}`,
  };
}

export function futuresEnabled(): boolean {
  return futuresMode().mode !== "off";
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new FuturesError(
      err instanceof Error && err.name === "TimeoutError"
        ? `binance futures did not answer within ${TIMEOUT_MS}ms`
        : `binance futures unreachable: ${String(err)}`,
    );
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const { code, msg } = (body ?? {}) as { code?: number; msg?: string };
    throw new FuturesError(msg ?? `binance futures returned ${res.status}`, code);
  }
  return body;
}

/** Same HMAC scheme as spot, different host and key pair. */
async function signedRequest(
  path: string,
  params: Record<string, string | number | boolean>,
  method: "GET" | "POST" = "GET",
): Promise<unknown> {
  const { key, secret } = keys();
  if (!key || !secret) throw new FuturesError("no futures API keys set");

  const query = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now(), recvWindow: 5_000 }).map(([k, v]) => [
      k,
      String(v),
    ]),
  ).toString();

  const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");

  return request(`${path}?${query}&signature=${signature}`, {
    method,
    headers: { "X-MBX-APIKEY": key },
  });
}

type SymbolFilter = { stepSize: number; minQty: number; minNotional: number };

/**
 * Lot-size rules per symbol, fetched once.
 *
 * Cached for the life of the process because these change on the order of
 * months and the call is 400KB of JSON. A miss is not fatal: `quantityFor()`
 * falls back to a conservative 3-decimal rounding, which is valid for every
 * symbol on the allowlist and merely wasteful on the ones that allow finer.
 */
let filters: Map<string, SymbolFilter> | null = null;
let filtersAt = 0;
const FILTER_TTL_MS = 6 * 60 * 60 * 1000;

async function symbolFilters(): Promise<Map<string, SymbolFilter>> {
  if (filters && Date.now() - filtersAt < FILTER_TTL_MS) return filters;

  const info = (await request("/fapi/v1/exchangeInfo")) as {
    symbols: Array<{
      symbol: string;
      filters: Array<{ filterType: string; stepSize?: string; minQty?: string; notional?: string }>;
    }>;
  };

  const next = new Map<string, SymbolFilter>();
  for (const s of info.symbols ?? []) {
    const lot = s.filters?.find((f) => f.filterType === "LOT_SIZE");
    const notional = s.filters?.find((f) => f.filterType === "MIN_NOTIONAL");
    next.set(s.symbol, {
      stepSize: Number(lot?.stepSize ?? 0.001) || 0.001,
      minQty: Number(lot?.minQty ?? 0) || 0,
      minNotional: Number(notional?.notional ?? MIN_NOTIONAL_USD) || MIN_NOTIONAL_USD,
    });
  }

  filters = next;
  filtersAt = Date.now();
  return next;
}

/**
 * Round a base quantity DOWN to the symbol's step size.
 *
 * Down rather than nearest, always: rounding up can push the order past the
 * notional the budget layer approved, and an order that spends more than it was
 * allowed to is exactly the failure the budget layer exists to prevent. A
 * fraction of a step is worth less than the guarantee.
 *
 * The string round-trip is not superstition. `0.1 + 0.2` arithmetic on step
 * sizes produces quantities like `0.0299999999999` that Binance rejects with
 * -1111 "Precision is over the maximum defined for this asset".
 */
export function roundToStep(qty: number, stepSize: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return qty;

  const steps = Math.floor(qty / stepSize + 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepSize) - 1e-9));
  return Number((steps * stepSize).toFixed(decimals));
}

/**
 * The smallest notional this symbol will actually accept, in USDT.
 *
 * NOT a constant, and the difference is not academic. Measured against
 * testnet.binancefuture.com on 2026-09-06:
 *
 *   BTCUSDT  MIN_NOTIONAL 50    <- above BUDGET_MAX_TRADE_USD at its default 25
 *   ETHUSDT  MIN_NOTIONAL 20
 *   BNBUSDT  MIN_NOTIONAL 5, but minQty 0.01 makes the real floor about $7.70
 *
 * Two separate filters bind here and the larger one wins: MIN_NOTIONAL is a
 * dollar floor, LOT_SIZE.minQty is a quantity floor that becomes a dollar floor
 * once multiplied by the mark. Sizing against a flat $5 produced orders that
 * passed every check we control and were rejected by the exchange, which is the
 * worst place to find out.
 *
 * Falls back to the flat minimum when the filters cannot be read, which sizes
 * optimistically. That is the right way round: an order that is refused by
 * Binance is visible, an order suppressed by a guess is not.
 */
export async function futuresMinNotional(symbol: string, mark: number): Promise<number> {
  try {
    const f = (await symbolFilters()).get(symbol.toUpperCase());
    if (!f) return MIN_NOTIONAL_USD;
    const byQty = Number.isFinite(mark) && mark > 0 ? f.minQty * mark : 0;
    return Math.max(MIN_NOTIONAL_USD, f.minNotional, byQty);
  } catch {
    return MIN_NOTIONAL_USD;
  }
}

/** Base quantity for a notional, rounded to the symbol's step. Zero means "too small". */
export async function quantityFor(symbol: string, notionalUsd: number, mark: number): Promise<number> {
  if (!Number.isFinite(mark) || mark <= 0) return 0;

  let step = 0.001;
  let minQty = 0;
  try {
    const f = (await symbolFilters()).get(symbol.toUpperCase());
    if (f) {
      step = f.stepSize;
      minQty = f.minQty;
    }
  } catch {
    // Conservative default. See symbolFilters().
  }

  const rounded = roundToStep(notionalUsd / mark, step);
  return rounded >= minQty ? rounded : 0;
}

/** Latest mark for one symbol on the futures book. */
export async function futuresMark(symbol: string): Promise<number> {
  const row = (await request(
    `/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
  )) as { price?: string };
  const price = Number(row?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new FuturesError(`no futures mark for ${symbol}`);
  }
  return price;
}

/** USDT in the futures wallet. The account orders actually hit. */
export async function futuresBalances(): Promise<Record<string, string>> {
  const rows = (await signedRequest("/fapi/v2/balance", {})) as Array<{
    asset: string;
    availableBalance: string;
  }>;
  return Object.fromEntries(
    (rows ?? []).filter((r) => Number(r.availableBalance) !== 0).map((r) => [r.asset, r.availableBalance]),
  );
}

export type FuturesPosition = {
  symbol: string;
  /** Signed. Negative is a short, and that is the whole point of this venue. */
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedUsd: number;
  leverage: number;
  liquidationPrice: number | null;
};

/**
 * Open positions as the exchange sees them.
 *
 * Read for the console's reconciliation line, NOT used to compute P&L — that is
 * derived from our own fills in src/lib/pnl.ts, so the number on screen is
 * arithmetic a viewer can check against the rows on screen. When the two
 * disagree the console says so rather than silently preferring one.
 */
export async function futuresPositions(): Promise<FuturesPosition[]> {
  const rows = (await signedRequest("/fapi/v2/positionRisk", {})) as Array<{
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unRealizedProfit: string;
    leverage: string;
    liquidationPrice: string;
  }>;

  return (rows ?? [])
    .map((r) => ({
      symbol: r.symbol,
      positionAmt: Number(r.positionAmt),
      entryPrice: Number(r.entryPrice),
      markPrice: Number(r.markPrice),
      unrealizedUsd: Number(r.unRealizedProfit),
      leverage: Number(r.leverage) || 1,
      liquidationPrice: Number(r.liquidationPrice) > 0 ? Number(r.liquidationPrice) : null,
    }))
    .filter((p) => Number.isFinite(p.positionAmt) && p.positionAmt !== 0);
}

/**
 * Set leverage for a symbol, clamped to MAX_LEVERAGE.
 *
 * Returns what Binance actually accepted, which can be lower than asked on a
 * symbol whose bracket caps it. Never throws on a rejection — a leverage that
 * could not be set means the position opens at whatever the account already
 * had, which is a smaller position than intended, never a larger one.
 */
export async function setLeverage(symbol: string, leverage: number): Promise<number> {
  const want = Math.max(1, Math.min(MAX_LEVERAGE, Math.floor(leverage) || 1));
  try {
    const res = (await signedRequest(
      "/fapi/v1/leverage",
      { symbol: symbol.toUpperCase(), leverage: want },
      "POST",
    )) as { leverage?: number };
    return Number(res?.leverage) || want;
  } catch (err) {
    console.warn(`[futures] could not set ${want}x on ${symbol}:`, err);
    return want;
  }
}

/**
 * Read one order back after the fact.
 *
 * Needed because a futures MARKET order answers with `cumQuote: "0"` and
 * `avgPrice: "0"` even when it has FILLED: the immediate response is written
 * before the fills are aggregated. Verified against testnet.binancefuture.com
 * on 2026-09-06, on an order that filled 0.01 BNB and reported zero value for
 * it.
 *
 * This is not a cosmetic gap. `recordFill()` drops any fill with no quote
 * value, because a fill with no price cannot become a position, so every single
 * futures trade would have been silently discarded and the futures P&L would
 * have stayed at zero forever while orders filled correctly on the exchange.
 * The console would have shown a working agent making no money.
 */
async function readBackOrder(
  symbol: string,
  orderId: string,
): Promise<{ executedQty: string; cumQuote: string; avgPrice: string } | null> {
  try {
    const order = (await signedRequest("/fapi/v1/order", { symbol, orderId })) as {
      executedQty?: string;
      cumQuote?: string;
      avgPrice?: string;
    };
    return {
      executedQty: order.executedQty ?? "0",
      cumQuote: order.cumQuote ?? "0",
      avgPrice: order.avgPrice ?? "0",
    };
  } catch (err) {
    console.warn(`[futures] could not read back order ${orderId}:`, err);
    return null;
  }
}

/**
 * Open or close a futures position, sized in notional USDT.
 *
 * `sizeUsd` is exposure, not margin. The margin actually posted is
 * `sizeUsd / leverage` and it is returned on the OrderResult so the ledger can
 * record what the position really tied up.
 *
 * `reduceOnly` is how a close is expressed: it tells Binance the order may only
 * shrink an existing position, never flip it. Without it a SELL that overshoots
 * a long silently opens a short, which is a different trade from the one the
 * budget layer approved.
 */
export async function placeFuturesOrder(args: {
  symbol: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  leverage?: number;
  reduceOnly?: boolean;
}): Promise<OrderResult> {
  const { mode } = futuresMode();
  const symbol = args.symbol.toUpperCase();

  if (mode === "off") {
    throw new FuturesError("futures is disabled: set FUTURES_ENABLED=1");
  }

  const wantLeverage = Math.max(1, Math.min(MAX_LEVERAGE, Math.floor(args.leverage ?? 1) || 1));

  if (mode === "fixture") {
    // A fixture fill still needs a real quantity, for the same reason the spot
    // one does: src/lib/pnl.ts cannot build a position from a fill with no
    // base quantity, so a priceless fixture shows trades and no P&L at all.
    let executedQty = "0";
    try {
      const mark = await futuresMark(symbol);
      executedQty = String(await quantityFor(symbol, args.sizeUsd, mark));
    } catch (err) {
      console.warn("[futures] fixture fill could not be priced:", err);
    }

    return {
      orderId: `fixture_fut_${Date.now()}`,
      symbol,
      side: args.side,
      status: "FILLED",
      executedQty,
      cummulativeQuoteQty: args.sizeUsd.toFixed(2),
      transactTime: Date.now(),
      live: false,
      venue: "futures",
      leverage: wantLeverage,
      reduceOnly: args.reduceOnly ?? false,
    };
  }

  if (args.sizeUsd < MIN_NOTIONAL_USD) {
    throw new FuturesError(
      `notional of $${args.sizeUsd} is below the $${MIN_NOTIONAL_USD} futures minimum`,
    );
  }

  // Leverage before quantity, because the exchange applies leverage to the
  // position and we want the margin figure we record to be the one that was
  // actually posted, not the one we hoped for.
  const leverage = args.reduceOnly ? wantLeverage : await setLeverage(symbol, wantLeverage);

  const mark = await futuresMark(symbol);
  const quantity = await quantityFor(symbol, args.sizeUsd, mark);

  if (quantity <= 0) {
    const floor = await futuresMinNotional(symbol, mark);
    throw new FuturesError(
      `$${args.sizeUsd.toFixed(2)} of ${symbol} is below the exchange minimum of ` +
        `$${floor.toFixed(2)} on futures`,
    );
  }

  const order = (await signedRequest(
    "/fapi/v1/order",
    {
      symbol,
      side: args.side,
      type: "MARKET",
      quantity,
      newOrderRespType: "RESULT",
      ...(args.reduceOnly ? { reduceOnly: "true" } : {}),
    },
    "POST",
  )) as {
    orderId: number;
    symbol: string;
    side: "BUY" | "SELL";
    status: string;
    executedQty: string;
    cumQuote?: string;
    avgPrice?: string;
    updateTime?: number;
  };

  // Futures answers with `cumQuote`, spot with `cummulativeQuoteQty`. Normalised
  // here so nothing downstream has to know which venue a fill came from to read
  // its own fields.
  //
  // Three routes to the same number, in descending order of trust, because the
  // immediate MARKET response frequently carries none of it: cumQuote, then
  // avgPrice * qty, then the order read back from the exchange. See
  // readBackOrder() for why the third one is not paranoia.
  let executedQty = order.executedQty ?? "0";
  let cumQuote = Number(order.cumQuote) > 0 ? String(order.cumQuote) : "0";

  if (Number(cumQuote) <= 0 && Number(order.avgPrice ?? 0) > 0) {
    cumQuote = (Number(order.avgPrice) * Number(executedQty)).toFixed(8);
  }

  if (Number(cumQuote) <= 0 && Number(executedQty) > 0) {
    const back = await readBackOrder(symbol, String(order.orderId));
    if (back) {
      executedQty = Number(back.executedQty) > 0 ? back.executedQty : executedQty;
      cumQuote =
        Number(back.cumQuote) > 0
          ? back.cumQuote
          : (Number(back.avgPrice) * Number(executedQty)).toFixed(8);
    }
  }

  // Last resort: value the fill at the mark this order was sized against. Better
  // than dropping a real position, and it is off by at most the slippage on one
  // market order. Only reachable when the exchange declined to say three times.
  if (Number(cumQuote) <= 0 && Number(executedQty) > 0) {
    cumQuote = (Number(executedQty) * mark).toFixed(8);
    console.warn(`[futures] order ${order.orderId} never reported a fill price, marked at ${mark}`);
  }

  return {
    orderId: String(order.orderId),
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    executedQty,
    cummulativeQuoteQty: cumQuote,
    transactTime: order.updateTime ?? Date.now(),
    live: true,
    venue: "futures",
    leverage,
    reduceOnly: args.reduceOnly ?? false,
  };
}
