/**
 * The trade half of the tick, end to end:
 *   npx tsx scripts/strategy-smoke.ts            fixtures, offline
 *   npx tsx scripts/strategy-smoke.ts --live     real candles + real Gemini
 *   npx tsx scripts/strategy-smoke.ts --live --chart-only   candles only, no model
 *
 * intel -> candles -> technical snapshot -> conviction -> signal -> budget.
 *
 * The symbol list comes from the BUDGET allowlist, not from a literal. Those two
 * lists must be the same list: if the model is offered a pair the budget layer
 * will not approve, every trade it proposes gets blocked and the failure looks
 * like a broken model rather than a config mismatch.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

if (process.argv.includes("--live")) process.env.DEMO_MODE = "live";
const CHART_ONLY = process.argv.includes("--chart-only");

import { CANDLE_INTERVAL, exchangeMode, getCandles, getPrices } from "@/lib/exchange";
import { evaluateTrade, limitsFromEnv } from "@/lib/budget";
import { llmMode, signalFromIntel } from "@/lib/llm";
import { conviction, technicalSnapshot, type TechnicalSnapshot } from "@/lib/strategy";
import { getLatestIntel, refreshIntel } from "@/lib/intel-cache";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const limits = limitsFromEnv();
  const symbols = limits.allowedSymbols;
  console.log(`[strategy] exchange ${exchangeMode().mode.toUpperCase()} (${exchangeMode().reason})`);
  console.log(`[strategy] llm      ${llmMode("signal").mode.toUpperCase()} (${llmMode("signal").reason})`);
  console.log(`[strategy] symbols  ${symbols.join(", ")} @ ${CANDLE_INTERVAL}`);

  console.log("\n--- 1. intel ---");
  await refreshIntel({ force: true });
  const intel = getLatestIntel();
  console.log(`${intel.direction} @ ${intel.confidence}  ${intel.headline}`);
  check("have an intel row to act on", Boolean(intel?.id));

  console.log("\n--- 2. candles + technical snapshot ---");
  const snapshots: Record<string, TechnicalSnapshot | null> = {};
  for (const symbol of symbols) {
    try {
      const candles = await getCandles({ symbol });
      const snap = technicalSnapshot({ symbol, interval: CANDLE_INTERVAL, candles });
      snapshots[symbol] = snap;
      if (snap) {
        console.log(
          `  ${symbol.padEnd(9)} ${String(candles.length).padStart(4)} bars  ${snap.regime.padEnd(5)}` +
            `  px ${snap.price.toFixed(2).padStart(10)}  vs EMA200 ${snap.trendStrengthPct >= 0 ? "+" : ""}${snap.trendStrengthPct.toFixed(1)}%` +
            `  ATR ${snap.atrPct.toFixed(2)}%  RSI ${snap.rsi.toFixed(0)}  ${snap.breakout ?? "-"}`,
        );
      } else {
        console.log(`  ${symbol.padEnd(9)} ${candles.length} bars — not enough history for a snapshot`);
      }
    } catch (err) {
      console.log(`  ${symbol.padEnd(9)} candle fetch failed: ${String(err).slice(0, 90)}`);
      snapshots[symbol] = null;
    }
  }

  const withSnap = Object.values(snapshots).filter(Boolean).length;
  if (exchangeMode().mode === "live") {
    check("built a snapshot for every allowed symbol", withSnap === symbols.length,
      `${withSnap}/${symbols.length}`);
    check("snapshots carry real prices",
      Object.values(snapshots).every((s) => !s || s.price > 0));
  }

  console.log("\n--- 3. conviction (news vs chart) ---");
  const lead = symbols.find((s) => snapshots[s]) ?? symbols[0];
  const conv = conviction({ intel, snapshot: snapshots[lead] ?? null });
  console.log(`  ${lead}: score ${conv.score.toFixed(2)}  ${conv.label}  aligned=${conv.aligned}`);
  for (const r of conv.reasons) console.log(`    · ${r}`);
  check("conviction score is in range", conv.score >= -1 && conv.score <= 1);
  check("conviction explains itself", conv.reasons.length >= 4);

  if (CHART_ONLY) return;

  console.log("\n--- 4. signal (model proposes) ---");
  const prices = await getPrices(symbols);
  const t0 = Date.now();
  const signal = await signalFromIntel({ intel, prices, snapshots, conviction: conv });
  console.log(`  ${signal.side} ${signal.symbol} $${signal.sizeUsd} in ${Date.now() - t0}ms`);
  console.log(`  thesis: ${signal.thesis}`);
  console.log(`  conviction on signal: ${signal.convictionLabel ?? "(none)"} ${signal.convictionScore?.toFixed(2) ?? ""}`);

  check("signal names an allowed symbol", symbols.includes(signal.symbol.toUpperCase()),
    signal.symbol);
  check("size is inside the model's stated band", signal.sizeUsd >= 5 && signal.sizeUsd <= 50);
  check("signal is traceable to its intel", signal.intelId === intel.id);
  check("conviction rides along on the signal", signal.convictionScore !== undefined);

  console.log("\n--- 5. budget (code disposes) ---");
  const decision = evaluateTrade({ symbol: signal.symbol, sizeUsd: signal.sizeUsd, spentTodayUsd: 0 });
  console.log(`  ${decision.decision}: ${decision.reason}`);
  check("budget reached a decision", ["ALLOW", "BLOCK", "REQUIRE_APPROVAL"].includes(decision.decision));
  check("an allowed symbol at a legal size is not blocked on the allowlist",
    !decision.reason.includes("not on the allowlist"), decision.reason);

  console.log("\n--- 6. the BLOCKED beat ---");
  const tooBig = evaluateTrade({ symbol: signal.symbol, sizeUsd: 500, spentTodayUsd: 0 });
  console.log(`  $500 -> ${tooBig.decision}: ${tooBig.reason}`);
  check("an oversized trade is refused by code, not by the model", tooBig.decision === "BLOCK");
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\n[strategy-smoke] threw:", err);
    process.exit(1);
  });
