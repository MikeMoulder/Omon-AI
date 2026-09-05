/**
 * Smoke test for the exchange seam.
 *
 *   npx tsx scripts/exchange-smoke.ts                 prices only (no key needed)
 *   npx tsx scripts/exchange-smoke.ts --live          + balances, with Demo Mode keys
 *   npx tsx scripts/exchange-smoke.ts --live --order  + places a real Demo Mode order
 *
 * --order is opt-in so running the smoke never spends anything by accident.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

if (process.argv.includes("--live")) process.env.DEMO_MODE = "live";

import { getPrices, getBalances, placeOrder, exchangeMode, MIN_NOTIONAL_USD } from "@/lib/exchange";

const SYMBOLS = ["BNBUSDT", "BTCUSDT"];

async function main() {
  const { mode, reason } = exchangeMode();
  console.log(`[exchange-smoke] mode: ${mode.toUpperCase()}  (${reason})`);

  // Public — proves connectivity and the symbols-array encoding, no key required.
  const prices = await getPrices(SYMBOLS);
  console.log("\n--- prices ---");
  console.log(JSON.stringify(prices, null, 2));

  if (mode === "fixture") {
    console.log("\n[exchange-smoke] no keys — skipping balances and order.");
    console.log("Get free Demo Mode keys at https://demo.binance.com/en/my/settings/api-management,");
    console.log("put BINANCE_API_KEY / BINANCE_SECRET_KEY in .env.local, then re-run --live.");
    return;
  }

  const balances = await getBalances();
  console.log("\n--- balances ---");
  console.log(JSON.stringify(balances, null, 2));

  if (!process.argv.includes("--order")) {
    console.log("\n[exchange-smoke] pass --order to place a real Demo Mode order.");
    return;
  }

  const order = await placeOrder({ symbol: "BNBUSDT", side: "BUY", sizeUsd: MIN_NOTIONAL_USD + 1 });
  console.log("\n--- order ---");
  console.log(JSON.stringify(order, null, 2));
  console.log(`\n[exchange-smoke] ORDER ID ${order.orderId} — this is the number for the demo.`);
}

main().catch((err) => {
  console.error("[exchange-smoke] FAILED:", err);
  process.exit(1);
});
