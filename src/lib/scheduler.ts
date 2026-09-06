/**
 * The heartbeat's configuration and reported state.
 *
 * There is no timer in this file, and that is the whole point.
 *
 * WHY: `src/instrumentation.ts` runs in a SEPARATE MODULE GRAPH from the route
 * handlers. Next bundles it apart, so its `@/lib/ledger`, `@/lib/tick` and both
 * caches are DIFFERENT INSTANCES from the ones the routes use. A scheduler that
 * called `runTick()` directly from instrumentation therefore wrote to a ledger
 * nothing else could read — and far worse, its `spentTodayUsd()` saw an empty
 * ledger, so the daily cap was enforced twice independently and the real
 * exposure was double the configured limit.
 *
 * That was observed, not theorised: a scheduled beat filled a real order while
 * every route still reported `actionCount: 0`.
 *
 * So the timer lives in instrumentation and does nothing but `fetch` its own
 * `POST /api/cron/tick`. All state — ledger, caches, budget arithmetic — stays
 * inside the routes' single graph. It is also exactly how an external cron
 * would drive it, which means the two paths cannot diverge.
 *
 * INTERVAL: five minutes by default, and that number is not arbitrary. It
 * matches the intel and signal cache TTLs, so each beat finds the cache just
 * expired and does one round of real work. Faster buys nothing and burns the
 * Gemini free tier: 288 beats/day at five minutes against a ~1,000 request/day
 * allowance, with `INTEL_MAX_NEW=3` bounding the worst case.
 */
import { lastTick } from "@/lib/tick";

export const INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 5 * 60_000);

/** The heartbeat is on unless it was explicitly switched off. */
export function schedulerEnabled(): boolean {
  return process.env.TICK_AUTOSTART !== "0";
}

export type SchedulerStatus = {
  running: boolean;
  intervalMs: number;
  /** When the next beat is due, ISO. Null until the first one has run. */
  nextAt: string | null;
  /** When the last beat ran, ISO. Null before the first. */
  lastAt: string | null;
};

/**
 * Derived from the last beat rather than from the timer, because the timer is
 * in the other graph and cannot be asked. `lastTick()` is written by the route
 * the timer calls, so it is the same fact observed from the side that matters.
 */
export function schedulerStatus(): SchedulerStatus {
  const last = lastTick();
  const lastMs = last ? new Date(last.at).getTime() : null;

  return {
    running: schedulerEnabled(),
    intervalMs: INTERVAL_MS,
    nextAt: lastMs === null ? null : new Date(lastMs + INTERVAL_MS).toISOString(),
    lastAt: last?.at ?? null,
  };
}
