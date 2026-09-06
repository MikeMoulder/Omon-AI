/**
 * Tests for the futures seam.
 *   npx tsx scripts/futures-test.ts          unit only, no network, no keys
 *   npx tsx scripts/futures-test.ts --live   also opens a real Demo Mode session
 *
 * The unit half covers the two things that silently break a futures order and
 * look fine on screen while they do it: step size rounding, and the leverage
 * ceiling. Both are arithmetic, so both are checkable for free.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"] });

import assert from "node:assert/strict";
import {
  MAX_LEVERAGE,
  futuresMode,
  futuresBalances,
  futuresMark,
  futuresPositions,
  quantityFor,
  roundToStep,
} from "@/lib/futures";

const live = process.argv.includes("--live");

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\nroundToStep");

check("rounds down to the step, never up", () => {
  // Up would push the order past the notional the budget layer approved.
  assert.equal(roundToStep(0.0197, 0.001), 0.019);
  assert.equal(roundToStep(0.0199, 0.001), 0.019);
});

check("an exact multiple survives untouched", () => {
  assert.equal(roundToStep(0.02, 0.001), 0.02);
  assert.equal(roundToStep(3, 1), 3);
});

check("no float artifacts in the result", () => {
  // 0.1 + 0.2 arithmetic produces 0.0299999999999 here, which Binance rejects
  // with -1111 "Precision is over the maximum defined for this asset".
  const q = roundToStep(0.03, 0.01);
  assert.equal(q, 0.03);
  assert.equal(String(q), "0.03");
  assert.equal(String(roundToStep(0.029999999, 0.001)), "0.029");
});

check("below one step is zero, not a rejected order", () => {
  assert.equal(roundToStep(0.0004, 0.001), 0);
});

check("garbage in is zero out", () => {
  assert.equal(roundToStep(NaN, 0.001), 0);
  assert.equal(roundToStep(-1, 0.001), 0);
  assert.equal(roundToStep(0, 0.001), 0);
});

check("a zero step size passes the quantity through rather than dividing by it", () => {
  assert.equal(roundToStep(0.5, 0), 0.5);
});

console.log("\nleverage ceiling");

check("MAX_LEVERAGE is clamped to something survivable", () => {
  assert.ok(MAX_LEVERAGE >= 1 && MAX_LEVERAGE <= 20, `${MAX_LEVERAGE}x`);
});

console.log("\nmode reporting");

check("futures is off unless it is switched on", () => {
  const before = process.env.FUTURES_ENABLED;
  delete process.env.FUTURES_ENABLED;
  const mode = futuresMode();
  assert.equal(mode.mode, "off");
  assert.match(mode.reason, /FUTURES_ENABLED/);
  if (before !== undefined) process.env.FUTURES_ENABLED = before;
});

check("switched on without keys reports fixture, never live", () => {
  const saved = {
    enabled: process.env.FUTURES_ENABLED,
    demo: process.env.DEMO_MODE,
    fk: process.env.BINANCE_FUTURES_API_KEY,
    fs: process.env.BINANCE_FUTURES_SECRET_KEY,
    k: process.env.BINANCE_API_KEY,
    s: process.env.BINANCE_SECRET_KEY,
  };
  process.env.FUTURES_ENABLED = "1";
  delete process.env.DEMO_MODE;
  delete process.env.BINANCE_FUTURES_API_KEY;
  delete process.env.BINANCE_FUTURES_SECRET_KEY;
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_SECRET_KEY;

  const mode = futuresMode();
  assert.equal(mode.mode, "fixture");

  for (const [key, value] of [
    ["FUTURES_ENABLED", saved.enabled],
    ["DEMO_MODE", saved.demo],
    ["BINANCE_FUTURES_API_KEY", saved.fk],
    ["BINANCE_FUTURES_SECRET_KEY", saved.fs],
    ["BINANCE_API_KEY", saved.k],
    ["BINANCE_SECRET_KEY", saved.s],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function liveChecks(): Promise<void> {
  console.log("\nlive");
  const mode = futuresMode();
  console.log(`  mode: ${mode.mode} (${mode.reason})`);

  if (mode.mode !== "live") {
    console.log("  skipped: set FUTURES_ENABLED=1 and the futures keys to run these\n");
    return;
  }

  const mark = await futuresMark("BTCUSDT");
  check("a live mark comes back", () => assert.ok(mark > 0, `BTCUSDT ${mark}`));
  console.log(`        BTCUSDT ${mark}`);

  const q = await quantityFor("BTCUSDT", 20, mark);
  check("a $20 notional rounds to a placeable quantity", () => assert.ok(q > 0, String(q)));
  console.log(`        $20 -> ${q} BTC`);

  const balances = await futuresBalances();
  check("the futures wallet reads", () => assert.ok(typeof balances === "object"));
  console.log(`        ${JSON.stringify(balances)}`);

  const positions = await futuresPositions();
  check("positions read", () => assert.ok(Array.isArray(positions)));
  console.log(`        ${positions.length} open`);
}

async function main(): Promise<void> {
  if (live) await liveChecks();
  else console.log("\n(pass --live to hit the futures host)");

  console.log(failed === 0 ? `\n${passed} passed\n` : `\n${passed} passed, ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nfutures test threw:", err);
  process.exit(1);
});
