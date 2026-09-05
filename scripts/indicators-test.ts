/**
 * Verifies the TypeScript port against the ORIGINAL ren-ai JavaScript, on real
 * candle data, bar by bar:
 *
 *   npx tsx scripts/indicators-test.ts [path/to/ren-ai]
 *
 * A port that quietly disagrees with the implementation whose edge was measured
 * is worse than no port at all — the numbers would look plausible and be wrong.
 * So this does not assert against hand-copied expected values; it runs both
 * implementations over the same 1000 candles and demands they match to 1e-9.
 *
 * When the ren-ai checkout is not present the cross-check is skipped and the
 * self-contained property checks still run, so this passes in CI and offline.
 */
import fs from "node:fs";
import path from "node:path";

import type { Candle } from "@/lib/types";
import { atr, ema, priorRange, rsi } from "@/lib/indicators";
import { STRATEGY_DEFAULTS, conviction, technicalSnapshot, trendSignal } from "@/lib/strategy";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Deterministic pseudo-random walk, so the offline path still exercises real shapes. */
function syntheticCandles(n: number): Candle[] {
  let price = 100;
  let seed = 42;
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const drift = (seed / 2147483648 - 0.45) * 2;
    const o = price;
    price = Math.max(1, price + drift);
    const h = Math.max(o, price) + Math.abs(drift) * 0.5;
    const l = Math.min(o, price) - Math.abs(drift) * 0.5;
    out.push({ t: i * 3_600_000, o, h, l, c: price, v: 100 + i });
  }
  return out;
}

async function main() {
  console.log("--- self-contained checks ---");

  const flat = Array.from({ length: 300 }, (_, i) => ({
    t: i,
    o: 50,
    h: 50,
    l: 50,
    c: 50,
    v: 1,
  }));
  const flatEma = ema(flat.map((c) => c.c), 50);
  check("ema of a constant series is that constant", near(flatEma[299] as number, 50));
  check("ema is sparse before the seed period", flatEma[48] === undefined);
  check("atr of a flat series is zero", atr(flat, 14) === 0);
  check("rsi with no losses is 100", rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14) === 100);
  check("ema returns empty when series is shorter than the period", ema([1, 2, 3], 50).length === 0);

  const synth = syntheticCandles(400);
  const range = priorRange(synth, 300, 10);
  const manualHigh = Math.max(...synth.slice(290, 300).map((c) => c.h));
  check("priorRange excludes the current bar", range !== null && near(range.high, manualHigh));

  const snap = technicalSnapshot({ symbol: "TESTUSDT", interval: "1h", candles: synth });
  check("snapshot is produced with enough history", snap !== null);
  check(
    "snapshot needs emaSlow+1 bars, and says so by returning null",
    technicalSnapshot({ symbol: "T", interval: "1h", candles: synth.slice(0, 150) }) === null,
  );
  if (snap) {
    check("atrPct is consistent with atr and price", near(snap.atrPct, (snap.atr / snap.price) * 100, 1e-9));
    check("regime agrees with the ema ordering",
      (snap.emaFast > snap.emaSlow && snap.regime !== "down") ||
        (snap.emaFast < snap.emaSlow && snap.regime !== "up") ||
        snap.regime === "flat");
  }

  console.log("\n--- conviction blending ---");
  const bullSnap = { ...(snap as NonNullable<typeof snap>), regime: "up" as const, breakout: "long" as const, trendStrengthPct: 5 };
  const bearSnap = { ...(snap as NonNullable<typeof snap>), regime: "down" as const, breakout: "short" as const, trendStrengthPct: -5 };

  const agree = conviction({ intel: { direction: "bullish", confidence: 0.8 }, snapshot: bullSnap });
  const clash = conviction({ intel: { direction: "bullish", confidence: 0.8 }, snapshot: bearSnap });
  const newsOnly = conviction({ intel: { direction: "bullish", confidence: 0.8 }, snapshot: null });
  const nothing = conviction({ intel: { direction: "neutral", confidence: 0.5 }, snapshot: null });

  check("agreement is flagged aligned", agree.aligned, `score ${agree.score.toFixed(2)}`);
  check("disagreement is not aligned", !clash.aligned, `score ${clash.score.toFixed(2)}`);
  check("agreement scores above disagreement", agree.score > clash.score);
  check("agreement scores above news alone", agree.score > newsOnly.score,
    `${agree.score.toFixed(2)} vs ${newsOnly.score.toFixed(2)}`);
  check("flat news + no chart is not counted as agreement", !nothing.aligned && nothing.score === 0);
  check("a clash of bullish news and bearish chart still leans down", clash.score < 0);
  check("score never leaves -1..1",
    [agree, clash, newsOnly, nothing].every((c) => c.score >= -1 && c.score <= 1));
  check("reasons are human-readable", agree.reasons.length >= 4);
  console.log("   " + agree.reasons.join("\n   "));

  // ---- cross-check against the original JavaScript -------------------------
  const renai = process.argv[2] ?? path.resolve(process.cwd(), "../ren-ai");
  const indicatorsJs = path.join(renai, "backend/src/engine/indicators.js");
  const strategyJs = path.join(renai, "backend/src/engine/strategies/trendBreakout.js");
  const cacheDir = path.join(renai, "backend/data/cache");

  if (!fs.existsSync(indicatorsJs)) {
    console.log(`\n--- cross-check SKIPPED (no ren-ai checkout at ${renai}) ---`);
    return;
  }

  console.log("\n--- cross-check against the original ren-ai JavaScript ---");
  const orig = (await import(`file://${indicatorsJs.replace(/\\/g, "/")}`)) as {
    ema: (v: number[], p: number) => number[];
    atr: (c: Candle[], p: number) => number;
    rsi: (c: number[], p: number) => number;
  };
  const origStrat = (await import(`file://${strategyJs.replace(/\\/g, "/")}`)) as {
    trendSignal: (c: Candle[], i: number, o?: object) => { active: boolean; side?: string };
  };

  const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  check("found cached candle files", files.length > 0, `${files.length} files`);

  let compared = 0;
  let emaMismatch = 0;
  let atrMismatch = 0;
  let rsiMismatch = 0;
  let signalMismatch = 0;
  const fired: string[] = [];

  for (const file of files) {
    const candles = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf8")) as Candle[];
    if (!Array.isArray(candles) || candles.length < 260) continue;
    const closes = candles.map((c) => c.c);

    const mine = ema(closes, 50);
    const theirs = orig.ema(closes, 50);
    for (let i = 0; i < closes.length; i += 1) {
      const a = mine[i];
      const b = theirs[i] as number | undefined;
      if (a === undefined && b === undefined) continue;
      if (a === undefined || b === undefined || !near(a, b)) emaMismatch += 1;
    }

    if (!near(atr(candles, 14), orig.atr(candles, 14))) atrMismatch += 1;
    if (!near(rsi(closes, 14), orig.rsi(closes, 14))) rsiMismatch += 1;

    // Walk every bar the strategy could evaluate, not just the last one.
    for (let i = STRATEGY_DEFAULTS.emaSlow; i < candles.length; i += 1) {
      const a = trendSignal(candles, i);
      const b = origStrat.trendSignal(candles, i);
      if (a.active !== b.active || a.side !== b.side) signalMismatch += 1;
      if (a.active) fired.push(`${file}@${i}:${a.side}`);
      compared += 1;
    }
  }

  check("ema matches the original on every bar", emaMismatch === 0, `${emaMismatch} mismatches`);
  check("atr matches the original", atrMismatch === 0, `${atrMismatch} files differ`);
  check("rsi matches the original", rsiMismatch === 0, `${rsiMismatch} files differ`);
  check("trendSignal matches the original on every bar", signalMismatch === 0,
    `${signalMismatch} of ${compared} bars differ`);
  check("the ported strategy actually fires on this data", fired.length > 0,
    `${fired.length} signals across ${files.length} files`);
  console.log(`   e.g. ${fired.slice(0, 4).join(", ")}`);
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\n[indicators-test] threw:", err);
    process.exit(1);
  });
