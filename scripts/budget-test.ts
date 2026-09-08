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
  maxLeverage: 3,
  maxQuoteAgeMs: 30_000,
  dailyLossHaltUsd: 50,
  maxDrawdownUsd: 75,
};

// Futures is opt-in, and evaluateTrade() refuses a futures trade on a build
// where it is off. The venue tests below assert the real rules, not the gate.
process.env.FUTURES_ENABLED = "1";

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

console.log("\nspot sells — the inventory guard");

check("blocks a spot sell when Omon holds nothing", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 10,
    spentTodayUsd: 0,
    limits: LIMITS,
    side: "SELL",
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /nothing to sell/);
});

check("blocks a spot sell larger than the position", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 0,
    limits: LIMITS,
    side: "SELL",
    holdingUsd: 12,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /more BNB than Omon holds/);
});

check("allows a spot sell inside the position", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 10,
    spentTodayUsd: 0,
    limits: LIMITS,
    side: "SELL",
    holdingUsd: 12,
  });
  assert.equal(d.decision, "ALLOW");
});

check("a sell is exempt from the daily cap — the agent can always exit", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 100, // cap fully consumed
    limits: LIMITS,
    side: "SELL",
    holdingUsd: 50,
  });
  assert.equal(d.decision, "ALLOW");
  assert.match(d.reason, /exempt/);
});

check("a buy at the same spent total is still blocked", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 100,
    limits: LIMITS,
    side: "BUY",
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /daily cap/);
});

console.log("\nfutures");

check("allows a futures short with no inventory — the point of the venue", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 0,
    limits: LIMITS,
    venue: "futures",
    side: "SELL",
    leverage: 2,
  });
  assert.equal(d.decision, "ALLOW");
  assert.match(d.reason, /margin at 2x/);
});

check("blocks leverage above the ceiling", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 0,
    limits: LIMITS,
    venue: "futures",
    side: "BUY",
    leverage: 10,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /leverage ceiling/);
});

check("checks notional against the cap, not margin — leverage cannot widen it", () => {
  // $20 at 4x posts $5 of margin. If the cap were checked against margin this
  // would pass with $95 already spent; it must not.
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 95,
    limits: LIMITS,
    venue: "futures",
    side: "BUY",
    leverage: 2,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /daily cap/);
});

check("a reduce-only futures close is exempt from the cap", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 20,
    spentTodayUsd: 100,
    limits: LIMITS,
    venue: "futures",
    side: "BUY",
    leverage: 2,
    reduceOnly: true,
  });
  assert.equal(d.decision, "ALLOW");
  assert.match(d.reason, /exempt/);
});

check("blocks a size below the symbol's own futures minimum", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT",
    sizeUsd: 6,
    spentTodayUsd: 0,
    limits: LIMITS,
    venue: "futures",
    side: "SELL",
    leverage: 1,
    minNotionalUsd: 7.66, // BNB perps: minQty 0.01 at a ~766 mark
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /below the \$7\.66 minimum for BNBUSDT on futures/);
});

check("says a symbol is untradable when its floor is above the cap", () => {
  // BTCUSDT perps want $50 of notional, which no $25 trade can reach. Saying so
  // once beats refusing every size one at a time.
  const d = evaluateTrade({
    symbol: "BTCUSDT",
    sizeUsd: 25,
    spentTodayUsd: 0,
    limits: LIMITS,
    venue: "futures",
    side: "BUY",
    leverage: 1,
    minNotionalUsd: 50,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /needs \$50\.00 minimum on futures, above the \$25 per-trade cap/);
});

check("spentToday ignores closes but counts opens", () => {
  const total = spentToday(
    [
      { kind: "trade", decision: "ALLOW", orderId: "1", payload: { sizeUsd: 20, side: "BUY" }, createdAt: iso(HOUR) },
      { kind: "trade", decision: "ALLOW", orderId: "2", payload: { sizeUsd: 20, side: "SELL" }, createdAt: iso(HOUR) },
      {
        kind: "trade",
        decision: "ALLOW",
        orderId: "3",
        payload: { sizeUsd: 30, side: "SELL", venue: "futures" },
        createdAt: iso(HOUR),
      },
      {
        kind: "trade",
        decision: "ALLOW",
        orderId: "4",
        payload: { sizeUsd: 15, side: "BUY", venue: "futures", reduceOnly: true },
        createdAt: iso(HOUR),
      },
    ],
    now,
  );
  // BUY spot 20 counts. Spot SELL is a close. Futures SELL 30 OPENS a short, so
  // it counts. The reduce-only futures BUY is a close.
  assert.equal(total, 50);
});


// ── Check 3: the quote must be fresh ────────────────────────────────────────
//
// A mark is an input to the size, so an old one silently voids the per-trade
// cap: the notional that reaches Binance is not the notional the gate approved.

check("a 2s-old mark is fresh enough to size on", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS, quoteAgeMs: 2_000 });
  assert.equal(d.decision, "ALLOW");
});

check("blocks a trade sized off a 45s-old mark", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS, quoteAgeMs: 45_000 });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /45\.0s old/);
});

check("a negative quote age is refused, not treated as fresh", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS, quoteAgeMs: -1 });
  assert.equal(d.decision, "BLOCK");
});

check("a NaN quote age is refused, not treated as fresh", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS, quoteAgeMs: Number.NaN });
  assert.equal(d.decision, "BLOCK");
});

check("an unmeasured quote age skips the check rather than assuming fresh", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "ALLOW");
  assert.equal(d.checks.find((c) => c.name === "quote is fresh")?.status, "skip");
});

// ── The trace itself ────────────────────────────────────────────────────────

check("an allowed trade records every check it ran", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS });
  assert.ok(d.checks.length >= 10);
});

check("check numbers are contiguous from 1", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS });
  d.checks.forEach((c, i) => assert.equal(c.n, i + 1));
});

check("a blocked trade names exactly one failing check", () => {
  const d = evaluateTrade({ symbol: "DOGEUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS });
  const failed = d.checks.filter((c) => c.status === "fail");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, "symbol is on the allowlist");
});

check("the trace stops at the check that refused", () => {
  const d = evaluateTrade({ symbol: "DOGEUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.checks.at(-1)?.status, "fail");
});


// ── Checks 10 and 11: the two ledger-wide halts ─────────────────────────────
//
// The per-trade and daily caps bound how much can be COMMITTED. Neither notices
// that every one of those trades lost. These two do.
//
// The property that matters most here is the exemption: both halts must stop the
// agent taking on risk and must never stop it shedding risk. An agent forbidden
// to exit a losing position because it is losing is in a strictly worse state
// than one that never traded.

check("allows an open while the day is only mildly down", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    realizedPnl24hUsd: -10,
  });
  assert.equal(d.decision, "ALLOW");
});

check("halts new risk once the day is at the loss limit", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    realizedPnl24hUsd: -50,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /\$50\.00 down/);
});

check("the daily loss halt never blocks a spot close", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    side: "SELL", holdingUsd: 100, realizedPnl24hUsd: -500,
  });
  assert.equal(d.decision, "ALLOW");
  assert.equal(d.checks.find((c) => c.name === "daily loss halt")?.status, "skip");
});

check("the daily loss halt never blocks a reduceOnly futures close", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    venue: "futures", leverage: 3, reduceOnly: true, realizedPnl24hUsd: -500,
  });
  assert.equal(d.decision, "ALLOW");
});

check("a profitable day does not halt", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    realizedPnl24hUsd: 30,
  });
  assert.equal(d.decision, "ALLOW");
});

check("allows an open while inside the drawdown limit", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    drawdownUsd: 20,
  });
  assert.equal(d.decision, "ALLOW");
});

check("halts new risk at the drawdown limit", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    drawdownUsd: 75,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /high-water mark/);
});

check("the drawdown halt never blocks a close", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    side: "SELL", holdingUsd: 100, drawdownUsd: 9_999,
  });
  assert.equal(d.decision, "ALLOW");
  assert.equal(d.checks.find((c) => c.name === "drawdown within limit")?.status, "skip");
});

check("a negative drawdown is refused, not read as healthy", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    drawdownUsd: -5,
  });
  assert.equal(d.decision, "BLOCK");
});

check("unmeasured ledger risk skips both halts rather than assuming healthy", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.checks.find((c) => c.name === "daily loss halt")?.status, "skip");
  assert.equal(d.checks.find((c) => c.name === "drawdown within limit")?.status, "skip");
  assert.equal(d.decision, "ALLOW");
});

check("the gate runs thirteen checks", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 20, spentTodayUsd: 0, limits: LIMITS,
    quoteAgeMs: 1_000, realizedPnl24hUsd: 0, drawdownUsd: 0,
  });
  assert.equal(d.checks.length, 13);
  d.checks.forEach((c, i) => assert.equal(c.n, i + 1));
});


// ── Closes are exempt from every size limit, not just the daily cap ─────────
//
// Found by the exit rules against the real ledger: a $25 per-trade cap with a
// $1000 daily allowance had let a spot position reach $198 over several beats,
// and the stop-loss that wanted to close it was refused for exceeding the cap.
// An agent that cannot exit is the exact state these exemptions exist to avoid.

check("a spot close above the per-trade cap is allowed", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 198, spentTodayUsd: 0, limits: LIMITS,
    side: "SELL", holdingUsd: 200,
  });
  assert.equal(d.decision, "ALLOW");
});

check("a reduceOnly futures close above the per-trade cap is allowed", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 198, spentTodayUsd: 0, limits: LIMITS,
    venue: "futures", leverage: 3, reduceOnly: true,
  });
  assert.equal(d.decision, "ALLOW");
});

check("a close above the cap is not parked in REQUIRE_APPROVAL either", () => {
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 198, spentTodayUsd: 0, limits: LIMITS,
    side: "SELL", holdingUsd: 200,
  });
  assert.notEqual(d.decision, "REQUIRE_APPROVAL");
  assert.equal(d.checks.find((c) => c.name === "within auto-approve threshold")?.status, "skip");
});

check("an OPEN above the per-trade cap is still refused", () => {
  const d = evaluateTrade({ symbol: "BNBUSDT", sizeUsd: 198, spentTodayUsd: 0, limits: LIMITS });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /per-trade cap/);
});

check("a close is still bounded by what is actually held", () => {
  // The exemption removes the cap, not the position. Selling more than the
  // ledger says Omon owns is still an order that would bounce.
  const d = evaluateTrade({
    symbol: "BNBUSDT", sizeUsd: 198, spentTodayUsd: 0, limits: LIMITS,
    side: "SELL", holdingUsd: 50,
  });
  assert.equal(d.decision, "BLOCK");
  assert.match(d.reason, /more BNB than Omon holds/);
});

console.log(`\n${passed} passed\n`);
