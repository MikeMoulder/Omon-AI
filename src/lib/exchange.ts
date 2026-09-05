/**
 * Exchange seam. The only file that talks to Binance.
 *
 * Execution runs on Binance Spot Testnet — a real matching engine with real
 * order ids and free test funds. Reads that need no key (prices) work against
 * the same host, so nothing here requires funding to develop against.
 *
 * Two Binance Agent OS surfaces meet in this file, and the split between them
 * is deliberate:
 *
 *   reads  (prices, candles)  Three rails, tried in order and every fall-through
 *                             recorded:
 *                               1. Binance MCP        src/lib/mcp.ts
 *                               2. Skill Hub CLI      src/lib/skillhub.ts
 *                               3. REST               the calls below
 *                             MCP is first when a token exists, but its client
 *                             is allowlisted and ours is refused, so in practice
 *                             the Skill Hub CLI is the Agent OS rail that
 *                             actually serves. REST is the floor that keeps the
 *                             tick alive when both are down.
 *   writes (orders)           REST only, against Spot Demo Mode.
 *
 * Writes never go through MCP. The MCP token authorises the operator's real
 * Binance account, so an order placed there would spend real money; Demo Mode
 * is a different host with different keys and no real funds. Keep it that way.
 *
 * Every fallback from MCP to REST is recorded via `noteMcpUse()` and shown on
 * the console. A silent fallback is the trap in handoff.md section 6.
 */
import crypto from "node:crypto";
import type { OrderResult, Candle } from "@/lib/types";
import { AGENT_OS_TOOLS, mcpCall, mcpEnabled, mcpMode, noteMcpUse } from "@/lib/mcp";
import { SKILL_HUB_COMMANDS, cliEnabled, cliKlines, cliMode, cliPrices } from "@/lib/skillhub";

// Binance SPOT Demo Mode, not Spot Testnet. Both are free and fund-free, but
// Demo Mode mirrors the live exchange — same features, same exchange filters,
// and order books "similar to the live exchange" — while Testnet runs an
// independent order book and resets balances monthly. Keys come from
// demo.binance.com API management, the same place the Futures Demo keys do.
const BASE = process.env.BINANCE_SPOT_BASE_PATH ?? "https://demo-api.binance.com";

/**
 * Where prices are read from when MCP is unavailable — separate from where
 * orders go, so the two can be pointed at different hosts if that is needed.
 *
 * Defaults to the execution host, which is accurate: Demo Mode order books track
 * the live exchange. Verified 2026-09-05 that BTCUSDT agreed within a cent
 * across mainnet, testnet and Binance MCP, so the fallback does not move the
 * numbers. `https://data-api.binance.vision` is the public mainnet alternative
 * if a host is ever blocked in production.
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
 * Raised when MCP answers successfully but with something the caller cannot
 * use. Separate from McpError so the fallback record distinguishes "the rail is
 * down" from "the rail worked and gave us the wrong thing" — they need
 * different fixes and the console should not blur them.
 */
class McpShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpShapeError";
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
 * Latest price for each symbol. Binance MCP first, REST as the fallback.
 *
 * ONE SYMBOL PER CALL on the MCP path, deliberately. The `symbols` array
 * parameter is unusable through MCP: the server serialises the array with a
 * space after each comma and Binance rejects that with `-1100 Illegal
 * characters found in parameter 'symbols'`. This is the same trap documented in
 * handoff.md section 6 for the REST path, and it survives the MCP layer because
 * the MCP layer is what does the serialising. Verified 2026-09-05.
 *
 * The REST fallback keeps the batch form, where the string is built by hand and
 * the space never appears.
 */
export async function getPrices(symbols: string[]): Promise<Record<string, string>> {
  if (symbols.length === 0) return {};

  if (mcpEnabled()) {
    try {
      const rows = await Promise.all(
        symbols.map(async (symbol) => {
          const row = (await mcpCall([...AGENT_OS_TOOLS.prices], { symbol })) as {
            symbol: string;
            price: string;
          };
          return [row.symbol, row.price] as const;
        }),
      );
      noteMcpUse("prices", { via: "mcp", tool: "spot_tickerPrice" });
      return Object.fromEntries(rows);
    } catch (err) {
      // Never fatal. Prices exist on both rails, so a dead token or a slow
      // gateway must not stop the tick — but it must not pass unnoticed either.
      noteMcpUse("prices", { via: "rest", reason: String(err) });
      console.warn("[exchange] mcp prices unavailable, falling back to REST:", err);
    }
  }

  // Skill Hub rail. Reached whenever MCP did not serve — no token, or a token
  // that failed. Needs no credentials for market data, which is the whole
  // reason it can carry the Agent OS claim when MCP cannot.
  if (cliEnabled()) {
    try {
      // One process for the whole batch — see cliPrices(). This is the only one
      // of the three rails where the batch form both works AND is worth having:
      // the cost on this rail is process spawn, not network.
      const prices = await cliPrices(symbols);
      noteMcpUse("prices", { via: "cli", tool: SKILL_HUB_COMMANDS.prices });
      return prices;
    } catch (err) {
      noteMcpUse("prices", { via: "rest", reason: String(err) });
      console.warn("[exchange] skill hub prices unavailable, falling back to REST:", err);
    }
  } else {
    noteMcpUse("prices", { via: "rest", reason: `${mcpOffReason()}; ${cliMode().reason}` });
  }

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

/** Raw kline rows are the same array-of-arrays on both rails. Decoded once. */
type RawKline = [number, string, string, string, string, string, ...unknown[]];

function decodeKlines(rows: RawKline[]): Candle[] {
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

/** Why MCP is not being used, for the fallback record. Read per call, not once
 *  at module scope, so a token added to the environment is picked up without a
 *  restart. */
function mcpOffReason(): string {
  return mcpMode().reason;
}

/**
 * OHLCV candles for one symbol. Binance MCP first, REST as the fallback.
 *
 * This is the load-bearing MCP call in the product, not the price label: these
 * candles are what `src/lib/indicators.ts` and `src/lib/strategy.ts` run on, so
 * the technical half of every signal Omon sells is computed from data fetched
 * through Binance Agent OS. Verified 2026-09-05 that `spot_klines` returns the
 * identical array-of-arrays shape as `/api/v3/klines`, which is why both rails
 * share `decodeKlines()` and the maths cannot drift between them.
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

  if (mcpEnabled()) {
    try {
      const mcpRows = (await mcpCall([...AGENT_OS_TOOLS.candles], {
        symbol: args.symbol,
        interval,
        limit,
      })) as RawKline[];

      if (!Array.isArray(mcpRows)) throw new McpShapeError("spot_klines did not return an array");

      const candles = decodeKlines(mcpRows);
      // A short series is not an error, but it silently disables every slow
      // indicator (emaSlow needs 200 bars). Treat it as a miss so the REST path
      // gets its chance rather than handing the strategy a stub.
      if (candles.length === 0) throw new McpShapeError("spot_klines returned no usable candles");

      noteMcpUse("candles", { via: "mcp", tool: "spot_klines" });
      delete lastCandleErrors[args.symbol];
      return candles;
    } catch (err) {
      noteMcpUse("candles", { via: "rest", reason: String(err) });
      console.warn(`[exchange] mcp candles for ${args.symbol} unavailable, falling back:`, err);
    }
  }

  // Skill Hub rail. `spot klines` returns the identical array-of-arrays shape as
  // `/api/v3/klines`, so it decodes through the same `decodeKlines()` as the
  // other two rails and the indicators cannot drift between them.
  if (cliEnabled()) {
    try {
      const cliRows = (await cliKlines({ symbol: args.symbol, interval, limit })) as RawKline[];
      const candles = decodeKlines(cliRows);
      if (candles.length === 0) throw new ExchangeError("skill hub klines returned no usable candles");

      noteMcpUse("candles", { via: "cli", tool: SKILL_HUB_COMMANDS.candles });
      delete lastCandleErrors[args.symbol];
      return candles;
    } catch (err) {
      noteMcpUse("candles", { via: "rest", reason: String(err) });
      console.warn(`[exchange] skill hub candles for ${args.symbol} unavailable, falling back:`, err);
    }
  } else {
    noteMcpUse("candles", { via: "rest", reason: `${mcpOffReason()}; ${cliMode().reason}` });
  }

  let rows: RawKline[];
  try {
    rows = (await request(
      `/api/v3/klines?symbol=${encodeURIComponent(args.symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
      undefined,
      PRICE_BASE,
    )) as RawKline[];
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

  return decodeKlines(rows);
}

/**
 * Non-zero spot balances on the DEMO account the trading keys belong to.
 *
 * Stays on REST on purpose. This is the account orders actually hit, and the
 * budget ledger is reconciled against it — reading a different account here
 * would make `spentToday()` describe a balance no trade ever touched. The
 * Agent OS view of the operator's real account is `getAgentOsAccount()` below,
 * and the two must not be confused for one another.
 */
export async function getBalances(): Promise<Record<string, string>> {
  const account = (await signedRequest("/api/v3/account", { omitZeroBalances: "true" })) as {
    balances: Array<{ asset: string; free: string }>;
  };
  return Object.fromEntries(account.balances.map((b) => [b.asset, b.free]));
}

/**
 * The operator's real Binance account, read through Binance MCP. READ ONLY.
 *
 * A different account from `getBalances()` — that one is Spot Demo Mode, this
 * one is mainnet — so the console must label them separately rather than adding
 * them up. Returned for the Agent OS status panel: it is what proves the MCP
 * connection is authenticated rather than merely reachable, since every other
 * MCP call in this file hits public market data that needs no token.
 *
 * Returns null instead of throwing when MCP is off or the token has expired.
 */
export async function getAgentOsAccount(): Promise<{
  uid: number;
  accountType: string;
  canTrade: boolean;
  balances: Record<string, string>;
} | null> {
  if (!mcpEnabled()) {
    noteMcpUse("account", { via: "rest", reason: mcpOffReason() });
    return null;
  }

  try {
    const account = (await mcpCall([...AGENT_OS_TOOLS.account], { omitZeroBalances: true })) as {
      uid: number;
      accountType: string;
      canTrade: boolean;
      balances?: Array<{ asset: string; free: string }>;
    };

    noteMcpUse("account", { via: "mcp", tool: "spot_getAccount" });

    return {
      uid: account.uid,
      accountType: account.accountType,
      canTrade: account.canTrade,
      balances: Object.fromEntries((account.balances ?? []).map((b) => [b.asset, b.free])),
    };
  } catch (err) {
    noteMcpUse("account", { via: "rest", reason: String(err) });
    console.warn("[exchange] mcp account read failed:", err);
    return null;
  }
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
