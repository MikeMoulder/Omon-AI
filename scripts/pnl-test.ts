/**
 * Tests for the P&L layer — the number a viewer trusts most and can check least.
 *   npx tsx scripts/pnl-test.ts
 * No network, no keys, no model. Runs in milliseconds.
 */
import assert from "node:assert/strict";
import { computeFuturesPnl, computePnl, computeVenuePnl } from "@/lib/pnl";
import type { Fill } from "@/lib/types";

let seq = 0;
const HOUR = 3_600_000;
const base = Date.parse("2026-09-06T12:00:00.000Z");

/** A fill `agoHours` before the fixed base time, priced by qty and quote. */
function fill(args: {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  quoteUsd: number;
  agoHours: number;
}): Fill {
  seq += 1;
  return {
    id: `fil_${seq}`,
    actionId: `act_${seq}`,
    orderId: `ord_${seq}`,
    symbol: args.symbol,
    side: args.side,
    qty: args.qty,
    quoteUsd: args.quoteUsd,
    price: args.quoteUsd / args.qty,
    live: true,
    createdAt: new Date(base - args.agoHours * HOUR).toISOString(),
  };
}

/** The same, on the futures venue. `leverage` decides the margin recorded. */
function perp(args: {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  agoHours: number;
  leverage?: number;
}): Fill {
  const leverage = args.leverage ?? 1;
  const quoteUsd = args.qty * args.price;
  seq += 1;
  return {
    id: `fil_${seq}`,
    actionId: `act_${seq}`,
    orderId: `ord_${seq}`,
    symbol: args.symbol,
    side: args.side,
    qty: args.qty,
    quoteUsd,
    price: args.price,
    live: true,
    venue: "futures",
    leverage,
    marginUsd: quoteUsd / leverage,
    createdAt: new Date(base - args.agoHours * HOUR).toISOString(),
  };
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Within a cent. Average cost is float arithmetic; exact equality is a trap. */
function near(actual: number, expected: number, msg: string) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${msg}: got ${actual}, want ${expected}`);
}

console.log("\ncomputePnl");

check("no fills is flat, not an error", () => {
  const p = computePnl([], { BTCUSDT: "90000" });
  assert.equal(p.totalUsd, 0);
  assert.equal(p.positions.length, 0);
  assert.equal(p.openCount, 0);
  assert.equal(p.totalPct, null);
});

check("one buy, price up — profit is open, not realised", () => {
  // $10 of BTC at 90,000, marked at 99,000: +10%.
  const p = computePnl([fill({ symbol: "BTCUSDT", side: "BUY", qty: 10 / 90000, quoteUsd: 10, agoHours: 1 })], {
    BTCUSDT: "99000",
  });
  near(p.unrealizedUsd, 1, "unrealised");
  near(p.realizedUsd, 0, "realised");
  near(p.totalUsd, 1, "total");
  near(p.totalPct ?? 0, 0.1, "total pct");
  assert.equal(p.openCount, 1);
  near(p.positions[0].avgCostUsd, 90000, "average cost");
});

check("one buy, price down — the loss is negative, not hidden", () => {
  const p = computePnl([fill({ symbol: "ETHUSDT", side: "BUY", qty: 0.004, quoteUsd: 12, agoHours: 1 })], {
    ETHUSDT: "2500",
  });
  near(p.totalUsd, -2, "total"); // 0.004 * 2500 = 10 against 12 paid
  assert.ok(p.positions[0].unrealizedUsd! < 0);
});

check("two buys at different prices average correctly", () => {
  const p = computePnl(
    [
      fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.0001, quoteUsd: 8, agoHours: 3 }), // 80,000
      fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.0001, quoteUsd: 10, agoHours: 1 }), // 100,000
    ],
    { BTCUSDT: "100000" },
  );
  near(p.positions[0].avgCostUsd, 90000, "average of 80k and 100k");
  near(p.costBasisUsd, 18, "cost basis");
  near(p.marketValueUsd, 20, "market value");
  near(p.totalUsd, 2, "total");
});

check("a full sell books the profit and leaves nothing open", () => {
  const p = computePnl(
    [
      fill({ symbol: "BNBUSDT", side: "BUY", qty: 0.02, quoteUsd: 10, agoHours: 2 }), // 500
      fill({ symbol: "BNBUSDT", side: "SELL", qty: 0.02, quoteUsd: 12, agoHours: 1 }), // 600
    ],
    { BNBUSDT: "600" },
  );
  near(p.realizedUsd, 2, "realised");
  near(p.unrealizedUsd, 0, "unrealised");
  near(p.totalUsd, 2, "total");
  assert.equal(p.openCount, 0);
  assert.equal(p.positions[0].qty, 0);
});

check("a half sell splits into realised and open, and the two add up", () => {
  const p = computePnl(
    [
      fill({ symbol: "BNBUSDT", side: "BUY", qty: 0.02, quoteUsd: 10, agoHours: 2 }), // 500
      fill({ symbol: "BNBUSDT", side: "SELL", qty: 0.01, quoteUsd: 6, agoHours: 1 }), // 600
    ],
    { BNBUSDT: "600" },
  );
  near(p.realizedUsd, 1, "realised on the half sold");
  near(p.unrealizedUsd, 1, "open on the half held");
  near(p.totalUsd, 2, "total");
  assert.equal(p.openCount, 1);
  near(p.costBasisUsd, 5, "remaining cost basis");
});

check("fills are folded oldest first however they arrive", () => {
  const buy = fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.0001, quoteUsd: 9, agoHours: 3 });
  const sell = fill({ symbol: "BTCUSDT", side: "SELL", qty: 0.0001, quoteUsd: 10, agoHours: 1 });
  // Newest first, the order the ledger actually hands them over in.
  const p = computePnl([sell, buy], { BTCUSDT: "100000" });
  near(p.realizedUsd, 1, "realised");
  assert.equal(p.openCount, 0);
});

check("selling more than was bought earns nothing on the excess", () => {
  // The demo account came with BNB already in it. Those units have no basis here.
  const p = computePnl(
    [
      fill({ symbol: "BNBUSDT", side: "BUY", qty: 0.01, quoteUsd: 5, agoHours: 2 }), // 500
      fill({ symbol: "BNBUSDT", side: "SELL", qty: 0.03, quoteUsd: 18, agoHours: 1 }), // 600
    ],
    { BNBUSDT: "600" },
  );
  near(p.realizedUsd, 1, "only the 0.01 with a basis books profit");
  assert.equal(p.openCount, 0);
  near(p.unbasedSells.BNBUSDT, 0.02, "excess recorded so the console can say so");
});

check("an unpriced position is excluded, never counted as zero", () => {
  const p = computePnl(
    [
      fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.0001, quoteUsd: 9, agoHours: 1 }),
      fill({ symbol: "ETHUSDT", side: "BUY", qty: 0.004, quoteUsd: 10, agoHours: 1 }),
    ],
    { BTCUSDT: "100000" }, // no ETH mark this beat
  );
  near(p.unrealizedUsd, 1, "only BTC contributes");
  assert.deepEqual(p.unpriced, ["ETHUSDT"]);
  const eth = p.positions.find((row) => row.symbol === "ETHUSDT")!;
  assert.equal(eth.markPrice, null);
  assert.equal(eth.unrealizedUsd, null);
});

check("a garbage mark is treated as no mark", () => {
  const p = computePnl([fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.0001, quoteUsd: 9, agoHours: 1 })], {
    BTCUSDT: "not-a-number",
  });
  assert.deepEqual(p.unpriced, ["BTCUSDT"]);
  assert.equal(p.unrealizedUsd, 0);
  assert.equal(p.totalUsd, 0);
});

check("a zero-quantity fill cannot enter a position", () => {
  const bad = { ...fill({ symbol: "BTCUSDT", side: "BUY", qty: 1, quoteUsd: 9, agoHours: 1 }), qty: 0 };
  const p = computePnl([bad], { BTCUSDT: "100000" });
  assert.equal(p.positions.length, 0);
  assert.equal(p.totalUsd, 0);
});

check("closing a position leaves no float dust behind", () => {
  const p = computePnl(
    [
      fill({ symbol: "BTCUSDT", side: "BUY", qty: 10 / 90000, quoteUsd: 10, agoHours: 2 }),
      fill({ symbol: "BTCUSDT", side: "SELL", qty: 10 / 90000, quoteUsd: 11, agoHours: 1 }),
    ],
    { BTCUSDT: "99000" },
  );
  assert.equal(p.positions[0].qty, 0);
  assert.equal(p.costBasisUsd, 0);
  near(p.realizedUsd, 1, "realised");
});

check("open positions sort above closed ones", () => {
  const p = computePnl(
    [
      fill({ symbol: "BNBUSDT", side: "BUY", qty: 0.02, quoteUsd: 10, agoHours: 4 }),
      fill({ symbol: "BNBUSDT", side: "SELL", qty: 0.02, quoteUsd: 11, agoHours: 3 }),
      fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.0001, quoteUsd: 9, agoHours: 2 }),
    ],
    { BTCUSDT: "100000", BNBUSDT: "600" },
  );
  assert.equal(p.positions[0].symbol, "BTCUSDT");
  assert.equal(p.positions[1].symbol, "BNBUSDT");
  near(p.totalUsd, 2, "1 realised on BNB plus 1 open on BTC");
});

console.log("\ncomputeFuturesPnl");

check("a short profits when the mark falls", () => {
  // The test the whole venue exists for. Spot average-cost arithmetic reports
  // this as a loss, which is why futures is not a flag on computePnl().
  const p = computeFuturesPnl([perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 1 })], {
    BTCUSDT: "79000",
  });
  assert.equal(p.positions[0].direction, "short");
  near(p.unrealizedUsd, 10, "short is up $10 when BTC falls $1000 on 0.01");
  assert.equal(p.shortCount, 1);
});

check("a short loses when the mark rises", () => {
  const p = computeFuturesPnl([perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 1 })], {
    BTCUSDT: "81000",
  });
  near(p.unrealizedUsd, -10, "short is down $10 when BTC rises $1000 on 0.01");
});

check("a long still profits when the mark rises", () => {
  const p = computeFuturesPnl([perp({ symbol: "BTCUSDT", side: "BUY", qty: 0.01, price: 80_000, agoHours: 1 })], {
    BTCUSDT: "81000",
  });
  assert.equal(p.positions[0].direction, "long");
  near(p.unrealizedUsd, 10, "long is up $10");
});

check("margin is notional over leverage", () => {
  const p = computeFuturesPnl(
    [perp({ symbol: "BNBUSDT", side: "BUY", qty: 0.1, price: 800, agoHours: 1, leverage: 4 })],
    { BNBUSDT: "800" },
  );
  near(p.notionalUsd, 80, "notional is qty * entry");
  near(p.marginUsd, 20, "margin is notional / 4");
  assert.equal(p.positions[0].leverage, 4);
});

check("return on margin is the leveraged return, and both are reported", () => {
  const p = computeFuturesPnl(
    [perp({ symbol: "BNBUSDT", side: "BUY", qty: 0.1, price: 800, agoHours: 1, leverage: 4 })],
    { BNBUSDT: "808" },
  );
  const row = p.positions[0];
  near(row.unrealizedUsd ?? 0, 0.8, "up $0.80 on $80 of notional");
  near((row.unrealizedPct ?? 0) * 100, 1, "1% on notional");
  near((row.returnOnMarginPct ?? 0) * 100, 4, "4% on margin at 4x");
});

check("closing a short books the profit and leaves nothing open", () => {
  const p = computeFuturesPnl(
    [
      perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 2 }),
      perp({ symbol: "BTCUSDT", side: "BUY", qty: 0.01, price: 79_000, agoHours: 1 }),
    ],
    { BTCUSDT: "79000" },
  );
  near(p.realizedUsd, 10, "sold at 80k, bought back at 79k");
  assert.equal(p.openCount, 0);
  near(p.unrealizedUsd, 0, "nothing left open");
});

check("a sell larger than the long flips the position and re-bases the entry", () => {
  // Long 0.01 at 80k, then sell 0.03 at 81k: closes the long for +$10 and opens
  // a 0.02 short AT 81k, not at the old 80k entry.
  const p = computeFuturesPnl(
    [
      perp({ symbol: "BTCUSDT", side: "BUY", qty: 0.01, price: 80_000, agoHours: 2 }),
      perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.03, price: 81_000, agoHours: 1 }),
    ],
    { BTCUSDT: "81000" },
  );
  const row = p.positions[0];
  assert.equal(row.direction, "short");
  near(row.qty, -0.02, "0.02 short remains");
  near(row.entryPrice, 81_000, "the new short started at the fill price");
  near(p.realizedUsd, 10, "the long booked +$10");
  near(p.unrealizedUsd, 0, "the new short is flat at its own entry");
});

check("adding to a short averages the entry", () => {
  const p = computeFuturesPnl(
    [
      perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 2 }),
      perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 82_000, agoHours: 1 }),
    ],
    { BTCUSDT: "81000" },
  );
  near(p.positions[0].entryPrice, 81_000, "average of 80k and 82k");
  near(p.unrealizedUsd, 0, "flat at the average entry");
});

check("an unpriced perp is excluded, never counted as zero", () => {
  const p = computeFuturesPnl([perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 1 })], {});
  assert.equal(p.positions[0].unrealizedUsd, null);
  assert.deepEqual(p.unpriced, ["BTCUSDT"]);
  near(p.unrealizedUsd, 0, "not in the total");
});

console.log("\nvenue separation");

check("futures fills never enter the spot P&L", () => {
  const rows = [
    fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.01, quoteUsd: 800, agoHours: 2 }),
    perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 1 }),
  ];
  const spot = computePnl(rows, { BTCUSDT: "79000" });
  // The spot side sees one BUY and nothing else. Without the venue filter the
  // perp SELL would close it and book a fabricated realised profit.
  assert.equal(spot.fillCount, 1);
  assert.equal(spot.openCount, 1);
  near(spot.realizedUsd, 0, "no spot sell happened");
});

check("spot fills never enter the futures P&L", () => {
  const rows = [fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.01, quoteUsd: 800, agoHours: 2 })];
  const fut = computeFuturesPnl(rows, { BTCUSDT: "79000" });
  assert.equal(fut.fillCount, 0);
  assert.equal(fut.positions.length, 0);
});

check("computeVenuePnl keeps the halves apart and totals them once", () => {
  const rows = [
    fill({ symbol: "BTCUSDT", side: "BUY", qty: 0.01, quoteUsd: 800, agoHours: 2 }),
    perp({ symbol: "BTCUSDT", side: "SELL", qty: 0.01, price: 80_000, agoHours: 1 }),
  ];
  const v = computeVenuePnl(rows, { BTCUSDT: "79000" });
  near(v.spot.totalUsd, -10, "the spot long is down $10");
  near(v.futures.totalUsd, 10, "the perp short is up $10");
  near(v.totalUsd, 0, "hedged flat overall, and the split says why");
  assert.equal(v.fillCount, 2);
});

check("pre-futures rows with no venue read as spot", () => {
  const legacy = fill({ symbol: "BNBUSDT", side: "BUY", qty: 0.026, quoteUsd: 20, agoHours: 1 });
  delete (legacy as { venue?: string }).venue;
  const v = computeVenuePnl([legacy], { BNBUSDT: "800" });
  assert.equal(v.spot.fillCount, 1);
  assert.equal(v.futures.fillCount, 0);
});

console.log(`\n${passed} passed\n`);
