/**
 * Tests for the budget layer — the one piece that must not be wrong.
 *   npx tsx scripts/budget-test.ts
 * No network, no keys, no model. Runs in milliseconds.
 */
import assert from "node:assert/strict";
import { evaluateTrade, spentToday, type BudgetLimits } from "@/lib/budget";

const LIMITS: BudgetLimits = {
  maxTradeUsd: 25,
  dailyTradeUsd: 100,
  allowedSymbols: ["BNBUSDT", "BTCUSDT"],
  requireApprovalAboveUsd: 25,
};

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log("\nevaluateTrade");

check("allows a normal trade", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 10, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "ALLOW");
  assert.equal(d.remainingUsd, 100);
});

check("blocks a symbol that is not on the allowlist", () => {
  const d = evaluateTrade({ symbol: "DOGEUSDT", sizeUsd: 10, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /allowlist/);
});

check("blocks a trade over the per-trade cap (the demo beat)", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 5000, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /per-trade cap/);
});

check("blocks a trade that would breach the daily cap", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 90, limits: LIMITS });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /daily cap/);
  assert.equal(d.remainingUsd, 10);
});

check("blocks a trade under the exchange minimum", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 2, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /minimum/);
});

check("requires approval above the auto-approve threshold", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 0,
    limits: { ...LIMITS, requireApprovalAboveUsd: 15 },
  });
  assert.equal(d.decision, "REQUIRE_APPROVAL");
});

console.log("\nevaluateTrade — hostile model output");

for (const bad of [NaN, Infinity, -Infinity, -10, 0]) {
  check(`blocks sizeUsd = ${String(bad)}`, () => {
    const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: bad, spentTodayUsd: 0, limits: LIMITS });
    assert.equal(d.decision, "BLOCK");
  });
}

check("blocks an empty symbol", () => {
  const d = evaluateTrade({ symbol: "", sizeUsd: 10, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "BLOCK");
});

check("never reports negative remaining budget", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 10, spentTodayUsd: 999, limits: LIMITS });
  assert.equal(d.remainingUsd, 0);
});

console.log("\nspentToday");

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

check("sums only allowed trades that produced an order", () => {
  const total = spentToday(
    [
      { kind: "trade", decision: "ALLOW", orderId: "1", payload: { sizeUsd: 10 }, createdAt: iso(HOUR) },
      { kind: "trade", decision: "ALLOW", orderId: "2", payload: { sizeUsd: 15 }, createdAt: iso(2 * HOUR) },
      { kind: "trade", decision: "BLOCK", orderId: null, payload: { sizeUsd: 999 }, createdAt: iso(HOUR) },
      { kind: "trade", decision: "ALLOW", orderId: null, payload: { sizeUsd: 50 }, createdAt: iso(HOUR) },
      { kind: "payout", decision: "ALLOW", orderId: "3", payload: { sizeUsd: 77 }, createdAt: iso(HOUR) },
    ],
    now,
  );
  assert.equal(total, 25);
});

check("ignores trades older than 24h", () => {
  const total = spentToday(
    [
      { kind: "trade", decision: "ALLOW", orderId: "1", payload: { sizeUsd: 10 }, createdAt: iso(HOUR) },
      { kind: "trade", decision: "ALLOW", orderId: "2", payload: { sizeUsd: 40 }, createdAt: iso(25 * HOUR) },
    ],
    now,
  );
  assert.equal(total, 10);
});

check("survives a malformed payload", () => {
  const total = spentToday(
    [
      { kind: "trade", decision: "ALLOW", orderId: "1", payload: {}, createdAt: iso(HOUR) },
      { kind: "trade", decision: "ALLOW", orderId: "2", payload: { sizeUsd: "abc" }, createdAt: iso(HOUR) },
      { kind: "trade", decision: "ALLOW", orderId: "3", payload: { sizeUsd: 5 }, createdAt: iso(HOUR) },
    ],
    now,
  );
  assert.equal(total, 5);
});

console.log(`\n${passed} passed\n`);
