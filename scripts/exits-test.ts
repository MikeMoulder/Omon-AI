/**
 * Tests for the exit rules — the half of a trade that limits damage.
 *   npx tsx scripts/exits-test.ts
 * No network, no keys, no model, no clock. Runs in milliseconds.
 *
 * `exitsFor` takes `now` as an argument precisely so this file can exist. A rule
 * that decides when to sell should never be verified any other way.
 */
import assert from "node:assert/strict";
import { exitsFor, exitDistance, type ExitLimits } from "@/lib/exits";
import type { Position, PerpPosition } from "@/lib/pnl";

const LIMITS: ExitLimits = {
  takeProfitPct: 2.5,
  stopLossPct: 1.5,
  maxHoldMs: 6 * 60 * 60 * 1000,
};

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

/** A priced spot holding. `pct` is a fraction, matching PnlSummary. */
function spot(over: Partial<Position> & { pct?: number | null; heldMs?: number }): Position {
  const { pct = 0, heldMs = HOUR, ...rest } = over;
  return {
    symbol: "BNBUSDT",
    qty: 0.1,
    avgCostUsd: 750,
    costBasisUsd: 75,
    markPrice: 760,
    marketValueUsd: 76,
    unrealizedUsd: 1,
    unrealizedPct: pct,
    realizedUsd: 0,
    fills: 1,
    lastFillAt: agoMs(heldMs),
    ...rest,
  };
}

function perp(over: Partial<PerpPosition> & { pct?: number | null; heldMs?: number }): PerpPosition {
  const { pct = 0, heldMs = HOUR, ...rest } = over;
  return {
    symbol: "ETHUSDT",
    qty: 0.01,
    direction: "long",
    entryPrice: 2500,
    notionalUsd: 25,
    marginUsd: 8.33,
    leverage: 3,
    markPrice: 2510,
    unrealizedUsd: 0.1,
    unrealizedPct: pct,
    returnOnMarginPct: pct === null ? null : pct * 3,
    realizedUsd: 0,
    fills: 1,
    lastFillAt: agoMs(heldMs),
    ...rest,
  };
}

const run = (spotRows: Position[] = [], futuresRows: PerpPosition[] = []) =>
  exitsFor({ spot: spotRows, futures: futuresRows, now: NOW, limits: LIMITS });

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log("\nexitsFor");

// ── nothing to do ───────────────────────────────────────────────────────────

check("a flat, recent, break-even book proposes nothing", () => {
  assert.deepEqual(run([spot({})], [perp({})]), []);
});

check("a position at zero qty is not proposed, even when old and losing", () => {
  assert.deepEqual(run([spot({ qty: 0, pct: -0.99, heldMs: 99 * HOUR })]), []);
});

check("a flat perp is not proposed", () => {
  assert.deepEqual(run([], [perp({ qty: 0, direction: "flat", pct: -0.99 })]), []);
});

// ── unpriced positions are skipped, never guessed at ────────────────────────

check("an unpriced spot holding is skipped rather than stopped out", () => {
  assert.deepEqual(run([spot({ markPrice: null, marketValueUsd: null, pct: null })]), []);
});

check("an unpriced perp is skipped rather than stopped out", () => {
  assert.deepEqual(run([], [perp({ markPrice: null, pct: null })]), []);
});

check("an unpriced position does not time-stop either, because the close needs a size", () => {
  // Tempting to allow it: the clock is knowable when the price is not, and a
  // stale thesis is stale whether or not the mark came back this beat. But the
  // order still has to be sized, and sizing an exit off a missing mark is the
  // same random sell the stop-loss skip exists to prevent. It waits a beat.
  const out = run([], [perp({ markPrice: null, pct: null, heldMs: 9 * HOUR })]);
  assert.equal(out.length, 0);
});

// ── the three rules ─────────────────────────────────────────────────────────

check("closes a spot winner at the take-profit", () => {
  const out = run([spot({ pct: 0.03 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rule, "take-profit");
  assert.equal(out[0].side, "SELL");
  assert.equal(out[0].venue, "spot");
  assert.match(out[0].reason, /up 3\.00%/);
});

check("closes a spot loser at the stop", () => {
  const out = run([spot({ pct: -0.02 })]);
  assert.equal(out[0].rule, "stop-loss");
  assert.match(out[0].reason, /down 2\.00%/);
});

check("closes anything held past the time-stop", () => {
  const out = run([spot({ pct: 0.001, heldMs: 7 * HOUR })]);
  assert.equal(out[0].rule, "time-stop");
  assert.match(out[0].reason, /held 7\.0h/);
});

check("the boundaries are inclusive on all three rules", () => {
  assert.equal(run([spot({ pct: 0.025 })])[0].rule, "take-profit");
  assert.equal(run([spot({ pct: -0.015 })])[0].rule, "stop-loss");
  assert.equal(run([spot({ pct: 0, heldMs: 6 * HOUR })])[0].rule, "time-stop");
});

check("just inside every boundary proposes nothing", () => {
  assert.deepEqual(run([spot({ pct: 0.0249 })]), []);
  assert.deepEqual(run([spot({ pct: -0.0149 })]), []);
  assert.deepEqual(run([spot({ pct: 0, heldMs: 6 * HOUR - 1 })]), []);
});

// ── futures: side is derived from the position, never from a model ──────────

check("a long perp closes by selling, reduceOnly", () => {
  const out = run([], [perp({ qty: 0.01, direction: "long", pct: 0.03 })]);
  assert.equal(out[0].side, "SELL");
  assert.equal(out[0].reduceOnly, true);
  assert.equal(out[0].sizeUsd, 25);
});

check("a short perp closes by buying, reduceOnly", () => {
  const out = run([], [perp({ qty: -0.01, direction: "short", pct: 0.03 })]);
  assert.equal(out[0].side, "BUY");
  assert.equal(out[0].reduceOnly, true);
});

check("a losing short still closes by buying", () => {
  const out = run([], [perp({ qty: -0.01, direction: "short", pct: -0.02 })]);
  assert.equal(out[0].rule, "stop-loss");
  assert.equal(out[0].side, "BUY");
});

// ── leverage must not move the trigger ──────────────────────────────────────

check("percentages are notional, so 3x does not fire the target early", () => {
  // returnOnMarginPct is +2.7% here, above the 2.5 target. The notional move is
  // only 0.9%, and that is the number the rule must use — otherwise the same
  // headline exits at 0.83% on futures and 2.5% on spot.
  const out = run([], [perp({ pct: 0.009, returnOnMarginPct: 2.7 })]);
  assert.deepEqual(out, []);
});

// ── precedence and ordering ─────────────────────────────────────────────────

check("a losing position past the time-stop reports the loss, not the clock", () => {
  const out = run([spot({ pct: -0.05, heldMs: 20 * HOUR })]);
  assert.equal(out[0].rule, "stop-loss");
});

check("stops are proposed before targets before time-stops", () => {
  const out = run([
    spot({ symbol: "BNBUSDT", pct: 0, heldMs: 9 * HOUR }),
    spot({ symbol: "BTCUSDT", pct: 0.04 }),
    spot({ symbol: "ETHUSDT", pct: -0.03 }),
  ]);
  assert.deepEqual(
    out.map((e) => e.rule),
    ["stop-loss", "take-profit", "time-stop"],
  );
});

check("both venues are considered in one pass", () => {
  const out = run([spot({ pct: -0.02 })], [perp({ pct: 0.03 })]);
  assert.equal(out.length, 2);
  assert.deepEqual(new Set(out.map((e) => e.venue)), new Set(["spot", "futures"]));
});

// ── the close is sized off the live mark, not the entry ─────────────────────

check("a spot close is sized at market value, not cost basis", () => {
  const out = run([spot({ pct: 0.03, marketValueUsd: 76.5, costBasisUsd: 75 })]);
  assert.equal(out[0].sizeUsd, 76.5);
});

// ── exitDistance is display-only and must not decide anything ───────────────

console.log("\nexitDistance");

check("reports the gap to each exit", () => {
  const d = exitDistance({ unrealizedPct: 0.01, lastFillAt: agoMs(2 * HOUR) }, NOW, LIMITS);
  assert.equal(d.toTakeProfitPct?.toFixed(2), "1.50");
  assert.equal(d.toStopLossPct?.toFixed(2), "2.50");
  assert.equal(d.toTimeStopMs, 4 * HOUR);
});

check("an unpriced position has no percentage distances but still has a clock", () => {
  const d = exitDistance({ unrealizedPct: null, lastFillAt: agoMs(HOUR) }, NOW, LIMITS);
  assert.equal(d.toTakeProfitPct, null);
  assert.equal(d.toStopLossPct, null);
  assert.equal(d.toTimeStopMs, 5 * HOUR);
});

check("the clock never reports negative time remaining", () => {
  const d = exitDistance({ unrealizedPct: 0, lastFillAt: agoMs(99 * HOUR) }, NOW, LIMITS);
  assert.equal(d.toTimeStopMs, 0);
});

console.log(`\n${passed} passed\n`);
