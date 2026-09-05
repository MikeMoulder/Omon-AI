/**
 * Smoke test for the Binance Skill Hub rail.
 *
 *   npx tsx scripts/skillhub-smoke.ts
 *   npx tsx scripts/skillhub-smoke.ts --verbose
 *
 * The counterpart to mcp-smoke.ts, and it asserts the same thing that script
 * does: not merely that prices and candles came back, but that they came back
 * over the Agent OS rail rather than quietly over REST. A fallback nobody
 * notices is how an integration ends up existing only in the README.
 *
 * Unlike mcp-smoke.ts this needs no credentials at all — Skill Hub market data
 * is ungated, which is exactly why it can carry the Agent OS claim.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

import { getCandles, getPrices, CANDLE_INTERVAL } from "@/lib/exchange";
import { mcpUsage } from "@/lib/mcp";
import { cliHealth, cliMode } from "@/lib/skillhub";

const verbose = process.argv.includes("--verbose");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const mode = cliMode();
  console.log(`\nSkill Hub mode: ${mode.mode.toUpperCase()} — ${mode.reason}\n`);

  if (mode.mode === "off") {
    console.log("The CLI is not available, so there is nothing to prove. Install it:");
    console.log("  https://github.com/binance/binance-cli/releases/latest\n");
    process.exit(1);
  }

  const health = await cliHealth();
  check("binance-cli answers --version", Boolean(health.version), health.version ?? health.error);

  console.log("\nprices");
  const prices = await getPrices(["BTCUSDT", "BNBUSDT"]);
  check("BTCUSDT has a price", Number(prices.BTCUSDT) > 0, verbose ? prices.BTCUSDT : "");
  check("BNBUSDT has a price", Number(prices.BNBUSDT) > 0, verbose ? prices.BNBUSDT : "");

  const priceUse = mcpUsage().prices;
  check(
    "prices were served by an Agent OS rail, not REST",
    priceUse?.via === "cli" || priceUse?.via === "mcp",
    `via: ${priceUse?.via ?? "none"}${priceUse?.reason ? ` (${priceUse.reason})` : ""}`,
  );

  console.log("\ncandles");
  const candles = await getCandles({ symbol: "BTCUSDT", limit: 300 });
  check("returns candles", candles.length > 0, `${candles.length} bars of ${CANDLE_INTERVAL}`);
  check(
    "enough bars for the slowest indicator (emaSlow needs 200)",
    candles.length >= 201,
    `${candles.length} bars`,
  );
  check(
    "candles are ordered oldest-first and closed",
    candles.length > 1 && candles[0].t < candles[candles.length - 1].t,
    verbose ? new Date(candles[candles.length - 1].t).toISOString() : "",
  );

  const candleUse = mcpUsage().candles;
  check(
    "candles were served by an Agent OS rail, not REST",
    candleUse?.via === "cli" || candleUse?.via === "mcp",
    `via: ${candleUse?.via ?? "none"}${candleUse?.reason ? ` (${candleUse.reason})` : ""}`,
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nskillhub-smoke failed:", err);
  process.exit(1);
});
