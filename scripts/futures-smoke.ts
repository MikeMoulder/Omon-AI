/**
 * Proves the futures rail end to end against the live host.
 *   npx tsx scripts/futures-smoke.ts            read only: mode, wallet, positions, sizing
 *   npx tsx scripts/futures-smoke.ts --trade    also opens the minimum position and closes it
 *
 * Read only by default because this is the one seam that can open a leveraged
 * position, and a smoke script that trades every time it runs is a smoke script
 * nobody runs before a demo.
 *
 * `--trade` is the assertion that actually matters: it opens at the exchange
 * minimum, checks the fill came back with a real order id and quantity, then
 * CLOSES it reduce-only and checks the position went flat. A test that opens and
 * does not close leaves the demo account carrying risk nobody chose.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"] });

import {
  MAX_LEVERAGE,
  futuresBalances,
  futuresMark,
  futuresMinNotional,
  futuresMode,
  futuresPositions,
  placeFuturesOrder,
  quantityFor,
} from "@/lib/futures";
import { computeFuturesPnl } from "@/lib/pnl";
import type { Fill } from "@/lib/types";

const trade = process.argv.includes("--trade");
const SYMBOL = process.env.FUTURES_SMOKE_SYMBOL ?? "BNBUSDT";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function main(): Promise<void> {
  console.log(`\nfutures smoke: ${SYMBOL}\n`);

  const mode = futuresMode();
  console.log(`  mode: ${mode.mode} (${mode.reason})\n`);

  if (mode.mode === "off") {
    console.log("  futures is switched off. Set FUTURES_ENABLED=1 to run this.\n");
    process.exit(0);
  }

  console.log("reads");
  const mark = await futuresMark(SYMBOL);
  check("a live mark comes back", mark > 0, `${SYMBOL} ${mark}`);

  const wallet = await futuresBalances();
  check("the futures wallet reads", typeof wallet === "object", JSON.stringify(wallet));
  check(
    "there is USDT to post as margin",
    Number(wallet.USDT ?? 0) > 0,
    `${wallet.USDT ?? 0} USDT`,
  );

  const before = await futuresPositions();
  check("positions read", Array.isArray(before), `${before.length} open`);
  for (const p of before) {
    console.log(
      `        ${p.symbol} ${p.positionAmt > 0 ? "long" : "short"} ${Math.abs(p.positionAmt)} ` +
        `from ${p.entryPrice} at ${p.leverage}x, unrealised ${p.unrealizedUsd}`,
    );
  }

  console.log("\nsizing");
  // The floor is per symbol, not a constant. BTCUSDT wants $50 of notional on
  // this host, BNBUSDT about $7.70 once minQty is multiplied by the mark.
  const floor = await futuresMinNotional(SYMBOL, mark);
  const notional = Math.ceil(floor * 100) / 100;
  check("the symbol's real minimum resolves", floor > 0, `$${floor.toFixed(2)} on ${SYMBOL}`);

  const qty = await quantityFor(SYMBOL, notional, mark);
  check(
    "the exchange minimum rounds to a placeable quantity",
    qty > 0,
    `$${notional.toFixed(2)} -> ${qty} ${SYMBOL.replace("USDT", "")}`,
  );
  check(
    "rounding never sizes UP past the approved notional",
    qty * mark <= notional + 1e-9,
    `${(qty * mark).toFixed(4)} <= ${notional}`,
  );
  check("the leverage ceiling is in force", MAX_LEVERAGE >= 1 && MAX_LEVERAGE <= 20, `${MAX_LEVERAGE}x`);

  if (!trade) {
    console.log("\n(pass --trade to open the minimum position and close it again)\n");
    console.log(failures === 0 ? "PASS\n" : `${failures} FAILURE(S)\n`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // ---- start flat ----
  //
  // The demo account can already be holding this symbol, from a previous run or
  // from before Omon existed. In one-way position mode a SELL against an open
  // long REDUCES it rather than opening a short, so a test that does not flatten
  // first is not testing what it says it is: the first run of this script
  // "opened a short" that was really a close, and the reduce-only close that
  // followed was rejected with -2022 because the position was already gone.
  const existing = before.find((p) => p.symbol === SYMBOL);
  if (existing) {
    console.log(`\nflattening a pre-existing ${existing.positionAmt > 0 ? "long" : "short"} first`);
    const flat = await placeFuturesOrder({
      symbol: SYMBOL,
      side: existing.positionAmt > 0 ? "SELL" : "BUY",
      sizeUsd: Math.abs(existing.positionAmt) * mark,
      leverage: 1,
      reduceOnly: true,
    });
    check("the pre-existing position closed", Boolean(flat.orderId), `order ${flat.orderId}`);
  }

  // ---- open ----
  console.log("\nopen");
  const open = await placeFuturesOrder({
    symbol: SYMBOL,
    side: "SELL", // short, because that is the trade spot cannot do
    sizeUsd: notional,
    leverage: 1,
  });
  check("the order came back", Boolean(open.orderId), `order ${open.orderId} ${open.status}`);
  check("it is tagged as futures", open.venue === "futures", String(open.venue));
  check("it filled a real quantity", Number(open.executedQty) > 0, open.executedQty);
  check("it moved real quote value", Number(open.cummulativeQuoteQty) > 0, open.cummulativeQuoteQty);

  const openQty = Number(open.executedQty);
  const openPrice = Number(open.cummulativeQuoteQty) / openQty;

  // ---- the fold, on the fill this run just produced ----
  const fills: Fill[] = [
    {
      id: "smoke_open",
      actionId: "smoke",
      orderId: open.orderId,
      symbol: open.symbol,
      side: open.side,
      qty: openQty,
      quoteUsd: Number(open.cummulativeQuoteQty),
      price: openPrice,
      live: open.live,
      venue: "futures",
      leverage: open.leverage ?? 1,
      marginUsd: Number(open.cummulativeQuoteQty) / (open.leverage ?? 1),
      createdAt: new Date().toISOString(),
    },
  ];

  const pnl = computeFuturesPnl(fills, { [SYMBOL]: String(mark) });
  check("the fold reads it as a short", pnl.positions[0]?.direction === "short", pnl.positions[0]?.direction);
  check("exposure is recorded", pnl.notionalUsd > 0, `$${pnl.notionalUsd.toFixed(2)} notional`);

  // ---- close ----
  console.log("\nclose");
  const close = await placeFuturesOrder({
    symbol: SYMBOL,
    side: "BUY",
    // Sized from what actually filled rather than what was asked for. A close
    // that is sized from the request can under-close after a partial fill and
    // leave the demo account carrying a position this script promised to remove.
    sizeUsd: openQty * mark,
    leverage: 1,
    reduceOnly: true,
  });
  check("the close came back", Boolean(close.orderId), `order ${close.orderId} ${close.status}`);
  check("it was sent reduce-only", close.reduceOnly === true, String(close.reduceOnly));

  const after = await futuresPositions();
  const still = after.find((p) => p.symbol === SYMBOL);
  check(
    "the position is flat again",
    !still || Math.abs(still.positionAmt) < 1e-9,
    still ? `${still.positionAmt} left` : "flat",
  );

  console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nfutures smoke threw:", err);
  process.exit(1);
});
