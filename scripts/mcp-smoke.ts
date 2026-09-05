/**
 * Proves the Binance MCP integration is real:
 *
 *   npx tsx scripts/mcp-smoke.ts            # asserts, exits non-zero on failure
 *   npx tsx scripts/mcp-smoke.ts --verbose  # also prints the values fetched
 *
 * This is the script a judge runs when they want to know whether "built with
 * Agent OS" is a claim or a fact. It does not mock anything: it opens a real
 * MCP session against agent.binance.com, lists the tools that token can see,
 * and pulls prices, candles and account state through them.
 *
 * It also asserts the thing that actually matters — that `getCandles()` served
 * its bars over MCP rather than quietly falling back to REST. A fallback that
 * nobody notices is how an integration ends up existing only in the README.
 */
import "dotenv/config";

import { getAgentOsAccount, getCandles, getPrices, CANDLE_INTERVAL } from "@/lib/exchange";
import { mcpHealth, mcpMode, mcpTools, mcpUsage, resolveTool, AGENT_OS_TOOLS } from "@/lib/mcp";

const verbose = process.argv.includes("--verbose");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const mode = mcpMode();
  console.log(`\nMCP mode: ${mode.mode.toUpperCase()} — ${mode.reason}\n`);

  if (mode.mode === "off") {
    console.log("No token, so there is nothing to prove. Run:");
    console.log("  npx tsx scripts/mcp-auth.ts");
    console.log("It writes .mcp-token.json for you — nothing to paste.\n");
    console.log("Note: MCP is disabled under DEMO_MODE=fixture. Set MCP_IN_FIXTURE_MODE=1");
    console.log("to exercise the real rail while the rest of the app stays on fixtures.\n");
    process.exit(1);
  }

  console.log("--- session ---");
  const tools = await mcpTools();
  check("tools/list returns tools", tools.length > 0, `${tools.length} tools`);

  console.log("\n--- the tools this product depends on ---");
  for (const [label, candidates] of Object.entries(AGENT_OS_TOOLS)) {
    const resolved = await resolveTool([...candidates]);
    check(`${label} tool published`, resolved !== null, resolved ?? "not found");
  }

  console.log("\n--- prices through MCP ---");
  const symbols = ["BTCUSDT", "BNBUSDT"];
  const prices = await getPrices(symbols);
  check(
    "every requested symbol priced",
    symbols.every((s) => Number(prices[s]) > 0),
    verbose ? JSON.stringify(prices) : `${Object.keys(prices).length} symbols`,
  );
  check(
    "prices came over MCP, not the REST fallback",
    mcpUsage().prices?.via === "mcp",
    mcpUsage().prices?.reason ?? mcpUsage().prices?.tool ?? "",
  );

  console.log("\n--- candles through MCP (the strategy's input) ---");
  const candles = await getCandles({ symbol: "BNBUSDT", limit: 300 });
  check("candles returned", candles.length > 0, `${candles.length} closed bars @ ${CANDLE_INTERVAL}`);
  // 201 is the real floor: emaSlow needs 200 bars plus one to have a previous
  // value. Below it the technical half silently disappears from every signal.
  check("enough bars for emaSlow(200)", candles.length >= 201, `${candles.length} bars`);
  check(
    "bars are ordered oldest first",
    candles.length > 1 && candles[0].t < candles[candles.length - 1].t,
  );
  check(
    "candles came over MCP, not the REST fallback",
    mcpUsage().candles?.via === "mcp",
    mcpUsage().candles?.reason ?? mcpUsage().candles?.tool ?? "",
  );
  if (verbose && candles.length) {
    console.log(`         latest close: ${candles[candles.length - 1].c}`);
  }

  console.log("\n--- account state through MCP (proves the token, not just the host) ---");
  const account = await getAgentOsAccount();
  check("account readable", account !== null, account ? `uid ${account.uid}` : "null");
  if (account) {
    check("account is a spot account", account.accountType === "SPOT", account.accountType);
    if (verbose) console.log(`         balances: ${JSON.stringify(account.balances)}`);
  }

  console.log("\n--- health summary (what the console renders) ---");
  console.log(JSON.stringify(await mcpHealth(), null, 2));

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nmcp-smoke crashed:", err);
  process.exit(1);
});
