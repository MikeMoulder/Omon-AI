/**
 * The intel cache. News comes in here, structured intelligence comes out, and
 * everything downstream reads this instead of calling a model.
 *
 * Why a cache and not a call-per-request: the paid endpoint must answer a buyer
 * in well under a second, and one intelFromHeadline() call is 3-15s. A buyer who
 * pays USDC and then waits fifteen seconds for a timeout is the worst outcome in
 * the product, so generating inside a paid request is not allowed anywhere.
 *
 * Freshness is a five minute TTL. Past that the rows are still served — stale
 * intel beats no intel for someone who already paid — but they are flagged
 * `fresh: false` with their age, and callers surface that. Never quietly serve
 * an hour-old row as if it were current.
 *
 * Storage is in-process. It survives across requests on a warm server and is
 * lost on a cold start, which is fine while this is the only reader; when the
 * database lands, this file is the one place that changes.
 */
import type { Intel } from "@/lib/types";
import { fetchHeadlines, newsMode } from "@/lib/news";
import { intelFromHeadline, keysAreSplit, llmMode } from "@/lib/llm";
import { latestIntel } from "@/lib/fixtures";

const TTL_MS = Number(process.env.INTEL_TTL_MS ?? 5 * 60_000);

/**
 * How many *new* headlines one refresh is allowed to analyse.
 *
 * This is a quota guard, not a tuning knob. The Gemini free tier is ~1,000
 * requests/day; a five minute refresh is 288 refreshes/day, so an unbounded
 * batch could burn the whole allowance before lunch and lock the account out on
 * the day we record. Deduping by URL means a typical refresh finds zero or one
 * genuinely new story anyway — this only bounds the worst case.
 */
const MAX_NEW_PER_REFRESH = Number(process.env.INTEL_MAX_NEW ?? 3);

/** Headlines pulled per refresh, before dedupe. */
const FETCH_LIMIT = Number(process.env.INTEL_FETCH_LIMIT ?? 10);

/** Rows kept in memory. The console shows a feed, not an archive. */
const MAX_ROWS = 20;

let rows: Intel[] = [];
let refreshedAt = 0;
let lastError: string | null = null;

/** URLs already analysed, so a story is never paid for twice. */
const analysed = new Set<string>();

/** One refresh at a time. Two concurrent ticks would double-spend the quota. */
let inflight: Promise<Intel[]> | null = null;

export type CacheStatus = {
  rows: number;
  fresh: boolean;
  ageMs: number | null;
  refreshedAt: string | null;
  ttlMs: number;
  lastError: string | null;
  news: ReturnType<typeof newsMode>;
  llm: ReturnType<typeof llmMode>;
  /** False means both agents share one Gemini quota. The console should say so. */
  llmKeysSplit: boolean;
};

function ageMs(): number | null {
  return refreshedAt === 0 ? null : Date.now() - refreshedAt;
}

export function isFresh(): boolean {
  const age = ageMs();
  return age !== null && age < TTL_MS;
}

export function intelCacheStatus(): CacheStatus {
  return {
    rows: rows.length,
    fresh: isFresh(),
    ageMs: ageMs(),
    refreshedAt: refreshedAt === 0 ? null : new Date(refreshedAt).toISOString(),
    ttlMs: TTL_MS,
    lastError,
    news: newsMode(),
    llm: llmMode("intel"),
    llmKeysSplit: keysAreSplit(),
  };
}

/**
 * Synchronous read. Never touches the network and never calls a model, so it is
 * safe inside a paid request. Falls back to the fixture row on a cold cache so
 * a buyer always receives a well-formed payload.
 */
export function getIntel(limit = 10): {
  intel: Intel[];
  fresh: boolean;
  ageMs: number | null;
  source: "cache" | "fixture";
} {
  if (rows.length === 0) {
    return { intel: [latestIntel()].slice(0, limit), fresh: false, ageMs: null, source: "fixture" };
  }
  return { intel: rows.slice(0, limit), fresh: isFresh(), ageMs: ageMs(), source: "cache" };
}

/** Newest single row, for callers that only want one. */
export function getLatestIntel(): Intel {
  return getIntel(1).intel[0];
}

async function doRefresh(): Promise<Intel[]> {
  const headlines = await fetchHeadlines(FETCH_LIMIT);
  const fresh = headlines.filter((h) => !analysed.has(h.url)).slice(0, MAX_NEW_PER_REFRESH);

  if (fresh.length === 0) {
    // Nothing new is a successful refresh, not a failure: it resets the clock
    // so a quiet news hour does not leave every row flagged stale.
    refreshedAt = Date.now();
    lastError = null;
    return rows;
  }

  // Mark before awaiting. If a call fails we still skip that URL next time
  // rather than retrying a headline the model already rejected once.
  for (const h of fresh) analysed.add(h.url);

  const settled = await Promise.allSettled(
    fresh.map((h) =>
      intelFromHeadline({ headline: h.title, sourceUrl: h.url, snippet: h.snippet }),
    ),
  );

  const produced = settled
    .filter((r): r is PromiseFulfilledResult<Intel> => r.status === "fulfilled")
    .map((r) => r.value);

  const failed = settled.length - produced.length;
  lastError = failed > 0 ? `${failed}/${settled.length} headline(s) failed analysis` : null;

  if (produced.length > 0) {
    rows = [...produced, ...rows].slice(0, MAX_ROWS);
    // Keep the dedupe set from growing without bound on a long-lived server.
    if (analysed.size > MAX_ROWS * 10) {
      analysed.clear();
      for (const r of rows) analysed.add(r.sourceUrl);
    }
  }

  refreshedAt = Date.now();
  return rows;
}

/**
 * Collect news and turn anything new into intel. This is what the tick calls.
 * Skips the work entirely while the cache is still fresh unless forced.
 *
 * Never throws — a feed or model outage leaves the previous rows in place and
 * records the reason in `lastError` for the console to show.
 */
export async function refreshIntel(opts: { force?: boolean } = {}): Promise<Intel[]> {
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
 */
export function revalidateIntel(): void {
  if (isFresh() || inflight) return;
  void refreshIntel();
}

/** Test hook. Drops every row and the dedupe set. */
export function __resetIntelCache(): void {
  rows = [];
  refreshedAt = 0;
  lastError = null;
  analysed.clear();
  inflight = null;
}
