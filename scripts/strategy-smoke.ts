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
import {
  conviction,
  technicalSnapshot,
  type Conviction,
  type TechnicalSnapshot,
} from "@/lib/strategy";
import { getLatestIntel, refreshIntel } from "@/lib/intel-cache";
import { MAX_LEVERAGE, futuresEnabled, futuresMinNotional } from "@/lib/futures";
import type { Intel } from "@/lib/types";

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
  // One score per symbol. The single `lead` score this used to build was always
  // the first allowed symbol's, whatever the model went on to trade — see the
  // `convictions` doc in src/lib/llm.ts. `conv` stays bound to the lead symbol
  // because the checks just below assert on the scorer itself, not on a signal.
  const lead = symbols.find((s) => snapshots[s]) ?? symbols[0];
  const conv = conviction({ intel, snapshot: snapshots[lead] ?? null });
  const convictions: Record<string, Conviction> = {};
  for (const symbol of symbols) {
    convictions[symbol] = conviction({ intel, snapshot: snapshots[symbol] ?? null });
  }
  console.log(`  ${lead}: score ${conv.score.toFixed(2)}  ${conv.label}  aligned=${conv.aligned}`);
  for (const r of conv.reasons) console.log(`    · ${r}`);
  check("conviction score is in range", conv.score >= -1 && conv.score <= 1);
  check("conviction explains itself", conv.reasons.length >= 4);

  if (CHART_ONLY) return;

  console.log("\n--- 4. signal (model proposes) ---");
  const prices = await getPrices(symbols);
  const t0 = Date.now();
  const signal = await signalFromIntel({ intel, prices, snapshots, convictions });
  console.log(`  ${signal.side} ${signal.symbol} $${signal.sizeUsd} in ${Date.now() - t0}ms`);
  console.log(`  thesis: ${signal.thesis}`);
  console.log(`  conviction on signal: ${signal.convictionLabel ?? "(none)"} ${signal.convictionScore?.toFixed(2) ?? ""}`);

  check("signal names an allowed symbol", symbols.includes(signal.symbol.toUpperCase()),
    signal.symbol);

  // The regression from 2026-09-06: the Signal used to carry the LEAD symbol's
  // conviction whatever it traded, so an ETHUSDT short shipped with BNBUSDT's
  // score driving its size and its leverage rule. Re-scoring the signal's own
  // symbol here must reproduce exactly what the signal stored.
  const own = conviction({ intel, snapshot: snapshots[signal.symbol] ?? null });
  check(
    "conviction on the signal is scored on the symbol the signal trades",
    signal.convictionScore === undefined ||
      Math.abs(signal.convictionScore - own.score) < 1e-9,
    `signal ${signal.symbol} stored ${signal.convictionScore?.toFixed(4)}, ` +
      `${signal.symbol} scores ${own.score.toFixed(4)}` +
      (lead === signal.symbol ? "" : ` (lead is ${lead}, ${convictions[lead].score.toFixed(4)})`),
  );
  check(
    "and its stated reasons are that symbol's chart, not the lead's",
    signal.convictionReasons === undefined ||
      JSON.stringify(signal.convictionReasons) === JSON.stringify(own.reasons),
    (signal.convictionReasons ?? []).join(" | "),
  );
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

  console.log("\n--- 7. the bearish path ---");
  //
  // The reason futures exists. trendSignal() has always detected short
  // breakouts and a spot account cannot trade one, so until this venue existed
  // every bearish read the engine produced was computed and discarded.
  //
  // Step 4 above uses whatever the news actually says, which on a green day is
  // bullish, so it never exercises this. A synthetic bearish intel row is the
  // only way to check the bearish half without waiting for a crash.
  if (!futuresEnabled()) {
    console.log("  futures is off, so a bearish read still has nowhere to go. Skipped.");
  } else {
    const bearish: Intel = {
      ...intel,
      id: `${intel.id}_bear`,
      headline: "Regulator opens enforcement action against a major exchange",
      summary:
        "A market-wide risk headline with no issuer-specific angle. Broad de-risking expected across majors.",
      direction: "bearish",
      confidence: 0.8,
    };

    const bearConvictions: Record<string, Conviction> = {};
    for (const symbol of symbols) {
      bearConvictions[symbol] = conviction({ intel: bearish, snapshot: snapshots[symbol] ?? null });
    }

    // The same per-symbol floors src/lib/signal-cache.ts resolves before every
    // real refresh. Passing them is not test scaffolding: without them the model
    // reaches for BTCUSDT, whose $50 futures minimum no $25 trade can meet, and
    // the whole venue looks broken when it is only misinformed.
    const futuresMinimums: Record<string, number> = {};
    for (const symbol of Object.keys(prices)) {
      const px = Number(prices[symbol]);
      if (Number.isFinite(px) && px > 0) {
        futuresMinimums[symbol] = await futuresMinNotional(symbol, px);
      }
    }
    console.log(
      `  futures minimums: ${Object.entries(futuresMinimums)
        .map(([sym, min]) => `${sym} $${min.toFixed(2)}`)
        .join(", ")}`,
    );

    const short = await signalFromIntel({
      intel: bearish,
      prices,
      snapshots,
      convictions: bearConvictions,
      futuresMinimums,
    });

    console.log(
      `  ${short.side} ${short.symbol} $${short.sizeUsd} on ${short.venue ?? "spot"}` +
        `${short.venue === "futures" ? ` at ${short.leverage ?? 1}x` : ""}`,
    );
    console.log(`  thesis: ${short.thesis}`);

    check(
      "a bearish read produces a sell rather than a buy",
      short.side === "SELL",
      `${short.side} ${short.symbol}`,
    );
    check(
      "and it routes to futures, where a short is actually possible",
      short.venue === "futures",
      String(short.venue),
    );
    check(
      "leverage stays inside the ceiling",
      (short.leverage ?? 1) >= 1 && (short.leverage ?? 1) <= MAX_LEVERAGE,
      `${short.leverage ?? 1}x of ${MAX_LEVERAGE}x`,
    );

    const floor = futuresMinimums[short.symbol] ?? 0;
    const verdict = evaluateTrade({
      symbol: short.symbol,
      sizeUsd: short.sizeUsd,
      spentTodayUsd: 0,
      venue: "futures",
      side: short.side,
      leverage: short.leverage ?? 1,
      minNotionalUsd: floor,
    });
    console.log(`  budget: ${verdict.decision}: ${verdict.reason}`);
    check(
      "the budget layer rules on the short without needing any inventory",
      ["ALLOW", "BLOCK", "REQUIRE_APPROVAL"].includes(verdict.decision),
      verdict.reason,
    );
    // The point of telling the model the floors. A short it cannot fill is a
    // beat wasted, and on a demo it reads as an agent that never trades.
    check(
      "the short it picked is one the cap can actually pay for",
      verdict.decision !== "BLOCK" || !verdict.reason.includes("per-trade cap"),
      verdict.reason,
    );
  }
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
