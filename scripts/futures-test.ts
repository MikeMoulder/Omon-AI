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
  futuresBalances,
  futuresMark,
  futuresMinNotional,
  futuresMode,
  futuresPositions,
  placeableNotional,
  placeableQuantity,
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

/**
 * The -4164 regression. Public endpoints only, so this runs without keys.
 *
 * On 2026-09-06 a SELL ETHUSDT $20.00 at 1x was ALLOWed by the budget layer and
 * refused by Binance twelve times in a row with "Order's notional must be no
 * smaller than 20". ETHUSDT's floor is $20 and its step is 0.001, so at a
 * 2499.10 mark the approved $20.00 rounded DOWN to 0.008 ETH — $19.99, seven
 * tenths of a cent short — and nothing about the next beat changed the sum.
 *
 * Both halves of the fix are checked here: placeableNotional() snapping before
 * the budget check, and placeableQuantity() recovering a step when the mark
 * moves between the snap and the order.
 *
 * check() is synchronous, so every await happens out here and the assertions
 * only ever look at values that have already landed.
 */
async function notionalChecks(): Promise<void> {
  console.log("\nplaceable notionals (public endpoints)");

  // The per-trade cap the drift guard is bounded by. Its default, not the
  // deployment's, so the test says the same thing on every machine.
  const cap = 25;

  for (const symbol of ["ETHUSDT", "BNBUSDT"]) {
    const mark = await futuresMark(symbol);
    const floor = await futuresMinNotional(symbol, mark);
    const approved = await placeableNotional(symbol, floor, mark);
    const naiveAtFloor = await quantityFor(symbol, floor, mark);
    // Half the floor is a sizing error, not a rounding one. It must come back
    // untouched so the budget layer can refuse it in words.
    const half = floor / 2;
    const belowFloorRequest = await placeableNotional(symbol, half, mark);
    const qty = await quantityFor(symbol, approved, mark);

    console.log(
      `  ${symbol} mark ${mark} floor $${floor.toFixed(2)} -> approved $${approved.toFixed(2)}`,
    );
    console.log(
      `        unsnapped $${floor.toFixed(2)} would have posted ` +
        `$${(naiveAtFloor * mark).toFixed(4)}`,
    );

    check(`${symbol}: a size on the floor snaps to something placeable`, () => {
      assert.ok(approved >= floor, `$${approved.toFixed(2)} >= $${floor.toFixed(2)}`);
      assert.ok(qty > 0, String(qty));
    });

    check(`${symbol}: the snapped size clears the floor after rounding down`, () => {
      assert.ok(
        qty * mark >= floor - 1e-9,
        `$${(qty * mark).toFixed(4)} >= $${floor.toFixed(2)}`,
      );
    });

    check(`${symbol}: a request below the floor is left alone, not inflated`, () => {
      assert.equal(
        belowFloorRequest,
        half,
        `$${half.toFixed(2)} came back as $${belowFloorRequest.toFixed(2)} — ` +
          `snapping a sizing gap, not a rounding one`,
      );
    });

    check(`${symbol}: the snap never overshoots what it was given`, () => {
      assert.ok(qty * mark <= approved + 1e-9, `$${(qty * mark).toFixed(4)} <= $${approved}`);
    });

    if (approved > cap) {
      console.log(`        over the $${cap} cap — the budget layer refuses this one in words`);
      continue;
    }

    // Walk the mark under the order. The naive round-down loses a whole step on
    // the way up, which is the sub-second window the drift guard exists for.
    let rejected = 0;
    let recovered = 0;
    let overCap = 0;
    let belowFloor = 0;
    let marks = 0;

    for (let bps = -300; bps <= 300; bps += 5) {
      const drifted = mark * (1 + bps / 10_000);
      const liveFloor = await futuresMinNotional(symbol, drifted);
      const naive = await quantityFor(symbol, approved, drifted);
      const guarded = await placeableQuantity(symbol, approved, drifted, cap);

      marks += 1;
      if (naive * drifted < liveFloor - 1e-9) {
        rejected += 1;
        if (guarded * drifted >= liveFloor - 1e-9) recovered += 1;
      }
      if (guarded * drifted > cap + 1e-9) overCap += 1;
      if (guarded * drifted < liveFloor - 1e-9) belowFloor += 1;
    }

    check(`${symbol}: the drift guard recovers every rejection across +/-3%`, () => {
      assert.equal(belowFloor, 0, `${belowFloor} of ${marks} marks still under the floor`);
      assert.equal(recovered, rejected, `${recovered} of ${rejected} recovered`);
    });

    check(`${symbol}: the drift guard never posts above the cap`, () => {
      assert.equal(overCap, 0, `${overCap} of ${marks} marks over $${cap}`);
    });

    console.log(`        ${marks} marks: ${rejected} would have been refused, all recovered`);
  }

  // A close is exempt from the floor at the exchange and must never be sized up,
  // or it sells more than the position holds.
  const ethMark = await futuresMark("ETHUSDT");
  const closeQty = await quantityFor("ETHUSDT", 5, ethMark);
  check("a close below the floor still has a quantity, unrounded upward", () => {
    assert.ok(closeQty > 0, String(closeQty));
    assert.ok(closeQty * ethMark <= 5 + 1e-9, `$${(closeQty * ethMark).toFixed(4)} <= $5`);
  });
}

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
  if (live) {
    await notionalChecks();
    await liveChecks();
  } else console.log("\n(pass --live to hit the futures host)");

  console.log(failed === 0 ? `\n${passed} passed\n` : `\n${passed} passed, ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nfutures test threw:", err);
  process.exit(1);
});
