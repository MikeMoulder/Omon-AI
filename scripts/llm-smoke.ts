/**
 * Smoke test for the LLM seam. Run BEFORE wiring it into a route:
 *   npx tsx scripts/llm-smoke.ts
 * With no GEMINI_API_KEY it exercises the fixture path and still passes, so it
 * is also the check that the fallback works.
 */
import dotenv from "dotenv";
// Next reads .env.local automatically; a plain node script does not — dotenv
// defaults to .env alone, so name both or the key is silently invisible.
dotenv.config({ path: [".env.local", ".env"], quiet: true });

// --live forces the real provider even when .env.local pins DEMO_MODE=fixture,
// which is the normal state of the repo. Set before the import so the module
// reads the overridden value.
if (process.argv.includes("--live")) process.env.DEMO_MODE = "live";

import { intelFromHeadline, signalFromIntel, keysAreSplit, llmMode } from "@/lib/llm";

async function main() {
  const intelMode = llmMode("intel");
  const signalMode = llmMode("signal");
  console.log(`[llm-smoke] intel : ${intelMode.mode.toUpperCase()}  (${intelMode.reason})`);
  console.log(`[llm-smoke] signal: ${signalMode.mode.toUpperCase()}  (${signalMode.reason})`);
  console.log(
    keysAreSplit()
      ? "[llm-smoke] keys are SPLIT — separate quota only if the projects differ too"
      : "[llm-smoke] keys are SHARED — one quota for both agents",
  );
  const { mode, reason } = intelMode;
  console.log(`[llm-smoke] mode: ${mode.toUpperCase()}  (${reason})`);
  if (mode === "fixture" && process.env.GEMINI_API_KEY) {
    console.log("[llm-smoke] a key IS set — re-run with --live to exercise the real provider");
  }

  const t0 = Date.now();

  const intel = await intelFromHeadline({
    headline: "US Treasury signals delay on stablecoin reserve rule",
    sourceUrl: "https://example.com/treasury-stablecoin-delay",
  });
  console.log("\n--- intel ---");
  console.log(JSON.stringify(intel, null, 2));

  const signal = await signalFromIntel({
    intel,
    prices: { BNBUSDT: "721.38", BTCUSDT: "79641.03" },
  });
  console.log("\n--- signal ---");
  console.log(JSON.stringify(signal, null, 2));

  console.log(`\n[llm-smoke] ok in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
}

main().catch((err) => {
  console.error("[llm-smoke] FAILED:", err);
  process.exit(1);
});
