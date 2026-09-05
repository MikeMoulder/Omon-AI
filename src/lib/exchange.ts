/**
 * Exchange seam. The only file that talks to Binance.
 *
 * Execution runs on Binance Spot Testnet — a real matching engine with real
 * order ids and free test funds. Reads that need no key (prices) work against
 * the same host, so nothing here requires funding to develop against.
 *
 * The Binance REST API is one of the surfaces Binance lists under Agent OS.
 * Prices for the console also come from the Binance MCP server, which is the
 * newer surface; this file is the write path.
 */
import crypto from "node:crypto";
import type { OrderResult, Candle } from "@/lib/types";

// Binance SPOT Demo Mode, not Spot Testnet. Both are free and fund-free, but
// Demo Mode mirrors the live exchange — same features, same exchange filters,
// and order books "similar to the live exchange" — while Testnet runs an
// independent order book and resets balances monthly. Keys come from
// demo.binance.com API management, the same place the Futures Demo keys do.
const BASE = process.env.BINANCE_SPOT_BASE_PATH ?? "https://demo-api.binance.com";

/**
 * Where prices are read from — separate from where orders go, so the two can be
 * pointed at different hosts if that is ever needed.
 *
 * Defaults to the execution host, which is accurate: Demo Mode order books track
 * the live exchange. Verified 2026-09-05 that BTCUSDT agreed within a cent
 * across mainnet, testnet and Binance MCP. `https://data-api.binance.vision` is
 * the public mainnet alternative if a host is ever blocked in production.
 */
const PRICE_BASE = process.env.BINANCE_PRICE_BASE_PATH ?? BASE;
const TIMEOUT_MS = Number(process.env.EXCHANGE_TIMEOUT_MS ?? 10_000);

/** Exchange-wide floor. An order under this is rejected by the NOTIONAL filter. */
export const MIN_NOTIONAL_USD = 5;

/**
 * Candle interval the strategy reads. Hourly by default rather than the 4H the
 * ren-ai log was measured on: 200 bars of 4H is 33 days of history and its
 * breakouts fire about once a week, which is too rare to show in a 2:15 demo.
 * 1h keeps the same rules on a clock the demo can actually reach.
 */
export const CANDLE_INTERVAL = process.env.CANDLE_INTERVAL ?? "1h";

export class ExchangeError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "ExchangeError";
  }
}

/**
 * Which path a write will take, and why. Same contract as llmMode() so the
 * console can show one honest status line per seam.
 */
export function exchangeMode(): { mode: "fixture" | "live"; reason: string } {
  if (process.env.DEMO_MODE === "fixture") {
    return { mode: "fixture", reason: "DEMO_MODE=fixture" };
  }
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
    return { mode: "fixture", reason: "BINANCE_API_KEY / BINANCE_SECRET_KEY not set" };
  }
  return { mode: "live", reason: `binance spot @ ${new URL(BASE).host}` };
}

async function request(path: string, init?: RequestInit, base = BASE): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ExchangeError(
      err instanceof Error && err.name === "TimeoutError"
        ? `binance did not answer within ${TIMEOUT_MS}ms`
        : `binance unreachable: ${String(err)}`,
    );
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // Binance errors are {code, msg} — surface both, they are genuinely useful.
    const { code, msg } = (body ?? {}) as { code?: number; msg?: string };
    throw new ExchangeError(msg ?? `binance returned ${res.status}`, code);
  }
  return body;
}

/** Signed request. Binance wants HMAC-SHA256 of the query string, appended to it. */
async function signedRequest(
  path: string,
  params: Record<string, string | number>,
  method: "GET" | "POST" = "GET",
): Promise<unknown> {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET_KEY;
  if (!key || !secret) throw new ExchangeError("BINANCE_API_KEY / BINANCE_SECRET_KEY not set");

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

/**
 * Latest price for each symbol. Public — no key, works before funding.
 *
 * Built as a raw string rather than URLSearchParams: Binance rejects the
 * `symbols` array if the JSON has a space after the comma, and the standard
 * serializers put one there.
 */
export async function getPrices(symbols: string[]): Promise<Record<string, string>> {
  if (symbols.length === 0) return {};

  const encoded = encodeURIComponent(`["${symbols.join('","')}"]`);
  const rows = (await request(
    `/api/v3/ticker/price?symbols=${encoded}`,
    undefined,
    PRICE_BASE,
  )) as Array<{ symbol: string; price: string }>;

  return Object.fromEntries(rows.map((row) => [row.symbol, row.price]));
}

/** Why the last candle fetch failed, per symbol. Read by the console. */
const lastCandleErrors: Record<string, string> = {};

export function candleErrors(): Record<string, string> {
  return { ...lastCandleErrors };
}

/**
 * OHLCV candles for one symbol. Public endpoint — no key, no signature.
 *
 * `limit` must cover the slowest indicator: the strategy needs emaSlow (200)
 * bars plus one, so anything under ~250 silently produces no snapshot at all.
 * Binance caps this at 1000, which is the default here for that reason.
 *
 * The last candle from this endpoint is the CURRENTLY OPEN one — its close
 * moves until the interval ends. Indicators must run on closed candles or the
 * same call gives a different answer every minute, so it is dropped.
 */
export async function getCandles(args: {
  symbol: string;
  interval?: string;
  limit?: number;
}): Promise<Candle[]> {
  const interval = args.interval ?? CANDLE_INTERVAL;
  const limit = Math.min(1000, Math.max(1, args.limit ?? 1000));

  let rows: Array<[number, string, string, string, string, string, ...unknown[]]>;
  try {
    rows = (await request(
      `/api/v3/klines?symbol=${encodeURIComponent(args.symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
      undefined,
      PRICE_BASE,
    )) as Array<[number, string, string, string, string, string, ...unknown[]]>;
  } catch (err) {
    // Degrade, do not throw. An empty series makes technicalSnapshot() return
    // null, which the Signal Agent already handles as "decide on news alone" —
    // one flaky symbol must not take the whole tick down mid-demo. The reason is
    // recorded rather than swallowed, because a silent fallback is how a broken
    // seam hides behind output that still looks correct.
    lastCandleErrors[args.symbol] = String(err);
    console.warn(`[exchange] candles for ${args.symbol} unavailable:`, err);
    return [];
  }

  delete lastCandleErrors[args.symbol];

  return rows
    .slice(0, -1)
    .map(([t, o, h, l, c, v]) => ({
      t,
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: Number(v),
    }))
    .filter((k) => Number.isFinite(k.c) && Number.isFinite(k.h) && Number.isFinite(k.l));
}

/** Non-zero spot balances on the account the keys belong to. */
export async function getBalances(): Promise<Record<string, string>> {
  const account = (await signedRequest("/api/v3/account", { omitZeroBalances: "true" })) as {
    balances: Array<{ asset: string; free: string }>;
  };
  return Object.fromEntries(account.balances.map((b) => [b.asset, b.free]));
}

/**
 * Place a market order sized in quote currency (USDT), not base.
 *
 * `quoteOrderQty` sidesteps LOT_SIZE rounding entirely — say what you want to
 * spend and Binance works out the quantity. The model proposes this order;
 * src/lib/budget.ts is what decides whether it may run.
 */
export async function placeOrder(args: {
  symbol: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
}): Promise<OrderResult> {
  const { mode } = exchangeMode();

  if (mode === "fixture") {
    return {
      orderId: `fixture_${Date.now()}`,
      symbol: args.symbol,
      side: args.side,
      status: "FILLED",
      executedQty: "0",
      cummulativeQuoteQty: args.sizeUsd.toFixed(2),
      transactTime: Date.now(),
      live: false,
    };
  }

  if (args.sizeUsd < MIN_NOTIONAL_USD) {
    throw new ExchangeError(
      `order of $${args.sizeUsd} is below the $${MIN_NOTIONAL_USD} exchange minimum`,
    );
  }

  const order = (await signedRequest(
    "/api/v3/order",
    {
      symbol: args.symbol,
      side: args.side,
      type: "MARKET",
      quoteOrderQty: args.sizeUsd.toFixed(2),
      newOrderRespType: "RESULT",
    },
    "POST",
  )) as {
    orderId: number;
    symbol: string;
    side: "BUY" | "SELL";
    status: string;
    executedQty: string;
    cummulativeQuoteQty: string;
    transactTime: number;
  };

  return {
    orderId: String(order.orderId),
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    executedQty: order.executedQty,
    cummulativeQuoteQty: order.cummulativeQuoteQty,
    transactTime: order.transactTime,
    live: true,
  };
}
