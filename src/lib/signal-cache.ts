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
 * Storage is durable as of 2026-09-06, the same as the intel cache and through
 * the same src/lib/store.ts: rows, the refresh clock and the set of intel ids
 * already turned into a signal go to `data/signals.json` and come back at boot.
 *
 * Restoring `analysed` matters more here than anywhere else. It is what stops
 * one story becoming two trades, and it used to be dropped on every restart —
 * so a restart inside a signal's TTL would build a second signal from the same
 * intel row and propose the same trade again. The ledger's `hasTradedSignal()`
 * is now durable too, so there were two independent guards to restore.
 *
 * The tick (handoff.md section 7) will drive `refreshSignals()` on an interval.
 * Until it exists, the paid route revalidates in the background on read, which
 * is the same mechanism `/api/intel` already uses.
 */
import type { Intel, Signal } from "@/lib/types";
import { CANDLE_INTERVAL, exchangeMode, getCandles, getPrices } from "@/lib/exchange";
import { llmMode, signalFromIntel } from "@/lib/llm";
import {
  conviction,
  technicalSnapshot,
  type Conviction,
  type TechnicalSnapshot,
} from "@/lib/strategy";
import { getIntel, intelCacheStatus } from "@/lib/intel-cache";
import { futuresEnabled, futuresMinNotional } from "@/lib/futures";
import { readDoc, writeDoc } from "@/lib/store";

/** What `data/signals.json` holds. Rows newest first, exactly as memory holds them. */
type SignalDoc = { rows: Signal[]; refreshedAt: number; analysed: string[] };

const DOC = "signals";

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

let hydrated = false;

/** Read the cache back off the disk, once per process. See the intel cache. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;

  const doc = readDoc<SignalDoc>(DOC);
  if (!doc || !Array.isArray(doc.rows)) return;

  rows = doc.rows.slice(0, MAX_ROWS);
  refreshedAt = typeof doc.refreshedAt === "number" ? doc.refreshedAt : 0;
  for (const id of doc.analysed ?? []) analysed.add(id);

  if (rows.length > 0) {
    console.log(`[signals] recovered ${rows.length} row(s) from disk`);
  }
}

/** Save after anything that changed the rows, the clock or the dedupe set. */
function persist(): void {
  writeDoc(DOC, { rows, refreshedAt, analysed: [...analysed] } satisfies SignalDoc);
}

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
  hydrate();
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
  hydrate();
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
    lastError = "intel cache is cold: refresh intel before building a signal";
    return rows;
  }

  const intel: Intel = latest[0];

  // Nothing new to reason about is a successful refresh, not a failure: it
  // resets the clock so a quiet news hour does not leave every row flagged
  // stale. Same rule as the intel cache.
  if (analysed.has(intel.id)) {
    refreshedAt = Date.now();
    lastError = null;
    persist();
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

  // One score per symbol, not one for the list.
  //
  // This used to score `lead` — the first allowed symbol with candle history,
  // which is BNBUSDT on any build whose BUDGET_ALLOWED_SYMBOLS starts with it —
  // and hand that single number to the model for whatever symbol it then chose.
  // The Signal carried it as its own conviction. Caught 2026-09-06 on a live
  // row: an ETHUSDT short stored `convictionReasons` reading "2.0% below the
  // 10-bar high" against a thesis citing ETH at 1.1%. BNB's chart was setting
  // the size and the leverage rule for an ETH trade.
  //
  // Symbols with no candles still get an entry: conviction() scores those as
  // "chart 0.00 (no candle history, news only)", which is the honest reading
  // and keeps every choosable symbol addressable in the map.
  const convictions: Record<string, Conviction> = {};
  for (const symbol of symbols) {
    convictions[symbol] = conviction({ intel, snapshot: snapshots[symbol] ?? null });
  }

  // What each symbol actually costs to trade on futures. Resolved here because
  // src/lib/llm.ts must not do network I/O, and the model needs it: BTC perps
  // want $50 of notional against a $25 per-trade cap, so without this the model
  // proposes BTC shorts that are structurally impossible to fill.
  const futuresMinimums: Record<string, number> = {};
  if (futuresEnabled()) {
    for (const symbol of symbols) {
      const mark = Number(prices[symbol]);
      if (!Number.isFinite(mark) || mark <= 0) continue;
      try {
        futuresMinimums[symbol] = await futuresMinNotional(symbol, mark);
      } catch {
        // An unknown floor leaves the symbol out of the prompt's tradable list,
        // which is the safe direction: the model proposes one it can fill.
      }
    }
  }

  const signal = await signalFromIntel({
    intel,
    prices,
    snapshots,
    convictions,
    futuresMinimums,
  });

  analysed.add(intel.id);
  rows = [signal, ...rows].slice(0, MAX_ROWS);
  refreshedAt = Date.now();
  lastError = null;
  persist();
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
  hydrate();
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
  hydrate();
  if (isFresh() || inflight) return;
  if (intelCacheStatus().rows === 0) return;
  void refreshSignals();
}

/** Test hook. Drops memory only; the file on disk is left alone. */
export function __resetSignalCache(): void {
  hydrated = true;
  rows = [];
  refreshedAt = 0;
  lastError = null;
  analysed.clear();
  inflight = null;
}
