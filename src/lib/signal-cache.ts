/**
 * The signal cache. Intel plus live Binance market data comes in here, trade
 * signals come out, and the paid endpoint reads this instead of calling a model.
 *
 * Same contract as src/lib/intel-cache.ts and for the same reason, only more so:
 * one signal costs a candle fetch per symbol AND a model call, which is 15-40s
 * end to end. Generating that inside a paid request would leave a buyer who has
 * already spent USDC waiting past most client timeouts. Never do it.
 *
 * Freshness is the same five minute TTL as intel. Past it the rows are still
 * served — a stale signal beats no signal for someone who already paid — but
 * flagged `fresh: false` with their age, so a buyer can judge for itself.
 *
 * Storage is in-process, like the intel cache: it survives across requests on a
 * warm server and is lost on a cold start. That was the demo risk on serverless;
 * on the VPS the process is long-lived, so the cache stays warm. When a database
 * lands, this file and intel-cache.ts are the two places that change.
 *
 * The tick (handoff.md section 7) will drive `refreshSignals()` on an interval.
 * Until it exists, the paid route revalidates in the background on read, which
 * is the same mechanism `/api/intel` already uses.
 */
import type { Intel, Signal } from "@/lib/types";
import { CANDLE_INTERVAL, exchangeMode, getCandles, getPrices } from "@/lib/exchange";
import { llmMode, signalFromIntel } from "@/lib/llm";
import { conviction, technicalSnapshot, type TechnicalSnapshot } from "@/lib/strategy";
import { getIntel, intelCacheStatus } from "@/lib/intel-cache";

const TTL_MS = Number(process.env.SIGNAL_TTL_MS ?? Number(process.env.INTEL_TTL_MS ?? 5 * 60_000));

/**
 * Symbols the signal is allowed to reason about.
 *
 * Deliberately read from the SAME variable the budget layer uses. If these two
 * lists ever diverge, every trade the model proposes gets blocked and the
 * failure looks like a broken model rather than a config mismatch — the trap
 * `scripts/strategy-smoke.ts` calls out at the top of its own file.
 */
function allowedSymbols(): string[] {
  return (process.env.BUDGET_ALLOWED_SYMBOLS ?? "BNBUSDT,BTCUSDT,ETHUSDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** Rows kept in memory. The console shows a feed, not an archive. */
const MAX_ROWS = 20;

let rows: Signal[] = [];
let refreshedAt = 0;
let lastError: string | null = null;

/** Intel ids already turned into a signal, so one story is not re-analysed. */
const analysed = new Set<string>();

/** One refresh at a time. Two concurrent ticks would double-spend the quota. */
let inflight: Promise<Signal[]> | null = null;

export type SignalCacheStatus = {
  rows: number;
  fresh: boolean;
  ageMs: number | null;
  refreshedAt: string | null;
  ttlMs: number;
  lastError: string | null;
  llm: ReturnType<typeof llmMode>;
  exchange: ReturnType<typeof exchangeMode>;
};

function ageMs(): number | null {
  return refreshedAt === 0 ? null : Date.now() - refreshedAt;
}

export function isFresh(): boolean {
  const age = ageMs();
  return age !== null && age < TTL_MS;
}

export function signalCacheStatus(): SignalCacheStatus {
  return {
    rows: rows.length,
    fresh: isFresh(),
    ageMs: ageMs(),
    refreshedAt: refreshedAt === 0 ? null : new Date(refreshedAt).toISOString(),
    ttlMs: TTL_MS,
    lastError,
    llm: llmMode("signal"),
    exchange: exchangeMode(),
  };
}

/**
 * Synchronous read. Never touches the network and never calls a model, so it is
 * safe inside a paid request.
 *
 * Unlike `getIntel()` there is no fixture fallback: a fabricated *trade* is a
 * different thing from a fabricated summary, and a buyer must never be handed
 * one dressed as real. A cold cache returns an empty array with
 * `source: "empty"`, and the route says so honestly.
 */
export function getSignals(limit = 10): {
  signals: Signal[];
  fresh: boolean;
  ageMs: number | null;
  source: "cache" | "empty";
} {
  if (rows.length === 0) {
    return { signals: [], fresh: false, ageMs: null, source: "empty" };
  }
  return { signals: rows.slice(0, limit), fresh: isFresh(), ageMs: ageMs(), source: "cache" };
}

/** Newest single row, or null on a cold cache. */
export function getLatestSignal(): Signal | null {
  return getSignals(1).signals[0] ?? null;
}

/**
 * Build one signal from the newest intel row and live market data.
 *
 * Conviction is computed in plain code (`src/lib/strategy.ts`) BEFORE the model
 * is asked, and passed in — the model writes the thesis, it does not get to
 * decide how much the chart agreed with the news.
 */
async function doRefresh(): Promise<Signal[]> {
  const { intel: latest, source } = getIntel(1);

  // NEVER build a signal from the fixture intel row.
  //
  // `getIntel()` falls back to a recorded headline on a cold cache so that
  // /api/intel always returns a well-formed payload — that is right for a
  // summary and wrong for a trade. A signal derived from a fixture is a
  // fabricated instruction to move money, and this cache feeds a PAID endpoint,
  // so it must never be manufactured from one. Callers that force a refresh
  // (the refresh route, the tick) reach this line with a cold cache after any
  // restart, so the guard lives here rather than only in revalidateSignals().
  if (source === "fixture") {
    lastError = "intel cache is cold — refresh intel before building a signal";
    return rows;
  }

  const intel: Intel = latest[0];

  // Nothing new to reason about is a successful refresh, not a failure: it
  // resets the clock so a quiet news hour does not leave every row flagged
  // stale. Same rule as the intel cache.
  if (analysed.has(intel.id)) {
    refreshedAt = Date.now();
    lastError = null;
    return rows;
  }

  const symbols = allowedSymbols();
  const prices = await getPrices(symbols);

  const snapshots: Record<string, TechnicalSnapshot | null> = {};
  for (const symbol of symbols) {
    // One flaky symbol must not take the whole refresh down — getCandles()
    // already degrades to an empty series rather than throwing, and
    // technicalSnapshot() returns null for one, which the Signal Agent handles
    // as "decide on news alone".
    const candles = await getCandles({ symbol, interval: CANDLE_INTERVAL });
    snapshots[symbol] =
      candles.length > 0 ? technicalSnapshot({ symbol, interval: CANDLE_INTERVAL, candles }) : null;
  }

  const lead = symbols.find((s) => snapshots[s]) ?? symbols[0];
  const conv = conviction({ intel, snapshot: snapshots[lead] ?? null });

  const signal = await signalFromIntel({ intel, prices, snapshots, conviction: conv });

  analysed.add(intel.id);
  rows = [signal, ...rows].slice(0, MAX_ROWS);
  refreshedAt = Date.now();
  lastError = null;
  return rows;
}

/**
 * Refresh the signal cache. Skips the work entirely while it is still fresh
 * unless forced.
 *
 * Never throws — a model or market-data outage leaves the previous rows in place
 * and records the reason in `lastError` for the console to show.
 */
export async function refreshSignals(opts: { force?: boolean } = {}): Promise<Signal[]> {
  if (!opts.force && isFresh()) return rows;
  if (inflight) return inflight;

  inflight = doRefresh()
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      return rows;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Fire-and-forget revalidation for read paths that must not block. Safe to call
 * on every request: the freshness check and the single-flight guard make all but
 * one of those calls a no-op.
 *
 * Also skipped while the intel cache is empty — building a signal off the
 * fixture intel row would put a fabricated trade in a paid response.
 */
export function revalidateSignals(): void {
  if (isFresh() || inflight) return;
  if (intelCacheStatus().rows === 0) return;
  void refreshSignals();
}

/** Test hook. Drops every row and the dedupe set. */
export function __resetSignalCache(): void {
  rows = [];
  refreshedAt = 0;
  lastError = null;
  analysed.clear();
  inflight = null;
}
