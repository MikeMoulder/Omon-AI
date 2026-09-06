/**
 * Smoke test for the console and the tick — the two pieces built last.
 *
 *   npx tsx scripts/console-smoke.ts                      # against localhost:3000
 *   npx tsx scripts/console-smoke.ts http://127.0.0.1:3117
 *   npx tsx scripts/console-smoke.ts --tick               # also run a live beat
 *
 * Needs a running server, like discovery-smoke.ts. It walks what a viewer sees:
 * the page answers, the SSE stream pushes a full snapshot, and every seam the
 * status row renders is present in it.
 *
 * `--tick` additionally drives one real beat and then a deliberately oversized
 * one, and asserts that the second is REFUSED. That second assertion is the
 * point of the whole budget layer: if a $99 trade ever reaches the exchange,
 * this script must fail loudly rather than the console quietly showing a fill.
 *
 * It costs model quota and places a real Demo Mode order, so it is opt-in.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const withTick = process.argv.includes("--tick");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/**
 * Read exactly one SSE frame, then hang up.
 *
 * Deliberately not a full EventSource: the stream never ends, so anything that
 * waits for the body to close would hang forever. One frame is all that needs
 * proving — the interval is the server's business.
 */
async function firstFrame(url: string, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`stream returned http ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream closed before a frame arrived");
      buffer += decoder.decode(value, { stream: true });

      const end = buffer.indexOf("\n\n");
      if (end === -1) continue;

      const frame = buffer.slice(0, end);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) throw new Error("frame carried no data line");
      return JSON.parse(line.slice(6));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type Snapshot = {
  seams: Record<string, { mode: string; reason: string }>;
  ledger: Record<string, number>;
  limits: { maxTradeUsd: number; dailyTradeUsd: number };
  money: { in: unknown[]; out: unknown[] };
  payment: { price: string; network: string };
  prices: Record<string, string>;
  maxLeverage: number;
  pnl: {
    spot: VenueSide & {
      positions: Array<{ symbol: string; qty: number; markPrice: number | null }>;
    };
    futures: VenueSide & {
      positions: Array<{
        symbol: string;
        qty: number;
        markPrice: number | null;
        direction: "long" | "short" | "flat";
        entryPrice: number;
        notionalUsd: number;
        marginUsd: number;
        leverage: number;
        unrealizedUsd: number | null;
      }>;
      longCount: number;
      shortCount: number;
      marginUsd: number;
    };
    totalUsd: number;
    fillCount: number;
  };
};

type VenueSide = {
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
  openCount: number;
  fillCount: number;
  unpriced: string[];
};

async function main(): Promise<void> {
  console.log(`\nconsole smoke: ${base}\n`);

  const page = await fetch(base);
  check("the console answers", page.ok, `http ${page.status}`);
  const html = await page.text();
  check("it is no longer the create-next-app template", !html.includes("To get started, edit the"));
  // The page mounts its EventSource from a client chunk, so the URL is in the
  // shipped JavaScript rather than in the HTML. Asserting on the HTML passed by
  // accident until the console was rewritten, which is the worst way for a test
  // to pass: it was checking that a string existed somewhere, not that the page
  // actually connects. Fetch the chunks and look for it properly.
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  let mounts = false;
  for (const src of scripts) {
    const chunk = await (await fetch(`${base}${src}`)).text();
    if (chunk.includes("/api/stream")) {
      mounts = true;
      break;
    }
  }
  check("it mounts against the stream", mounts, `${scripts.length} chunk(s) checked`);

  console.log("\nstream");
  const snapshot = (await firstFrame(`${base}/api/stream`)) as Snapshot;
  check("the first frame arrives immediately", Boolean(snapshot));

  const seams = ["intelAgent", "signalAgent", "news", "exchange", "futures", "mcp", "skillHub"];
  for (const seam of seams) {
    const row = snapshot.seams?.[seam];
    check(`${seam} reports a mode`, Boolean(row?.mode), row ? `${row.mode}: ${row.reason}` : "");
  }

  check(
    "the budget layer's limits are on screen",
    snapshot.limits?.maxTradeUsd > 0 && snapshot.limits?.dailyTradeUsd > 0,
    `$${snapshot.limits?.maxTradeUsd} per trade, $${snapshot.limits?.dailyTradeUsd} daily`,
  );
  check("the price is published", Boolean(snapshot.payment?.price), snapshot.payment?.price);
  check(
    "money in and money out are both present",
    Array.isArray(snapshot.money?.in) && Array.isArray(snapshot.money?.out),
  );

  // P&L is the number a viewer looks for first and the one they cannot check by
  // hand, so the shape is asserted even when the ledger is empty — a snapshot
  // with no `pnl` renders a console with no profit on it, which is the exact
  // bug this section exists to catch.
  const pnl = snapshot.pnl;
  check(
    "profit and loss is in the snapshot",
    Boolean(pnl) && typeof pnl.totalUsd === "number" && Boolean(pnl.spot) && Boolean(pnl.futures),
    pnl ? `${pnl.fillCount} fill(s), $${pnl.totalUsd.toFixed(4)} total` : "missing",
  );

  if (pnl) {
    // The venues are shown side by side on the console, so the split has to be
    // real in the data rather than a label over one shared number.
    check(
      "spot and futures are accounted separately",
      Array.isArray(pnl.spot.positions) && Array.isArray(pnl.futures.positions),
      `${pnl.spot.fillCount} spot fill(s), ${pnl.futures.fillCount} futures fill(s)`,
    );
    check(
      "the two venues add up to the headline",
      Math.abs(pnl.spot.totalUsd + pnl.futures.totalUsd - pnl.totalUsd) < 1e-9,
      `${pnl.spot.totalUsd.toFixed(4)} + ${pnl.futures.totalUsd.toFixed(4)} = ${pnl.totalUsd.toFixed(4)}`,
    );
    check(
      "no fill is counted on both venues",
      pnl.spot.fillCount + pnl.futures.fillCount === pnl.fillCount,
      `${pnl.fillCount} total`,
    );

    for (const [name, side] of [
      ["spot", pnl.spot],
      ["futures", pnl.futures],
    ] as const) {
      check(
        `${name}: realised and open add up`,
        Math.abs(side.realizedUsd + side.unrealizedUsd - side.totalUsd) < 1e-9,
        `${side.realizedUsd.toFixed(4)} + ${side.unrealizedUsd.toFixed(4)} = ${side.totalUsd.toFixed(4)}`,
      );
    }

    // An open position with no mark is excluded from the totals rather than
    // counted as zero, so it must be named or the number is quietly partial.
    const unmarked = pnl.spot.positions.filter((row) => row.qty > 0 && row.markPrice === null);
    check(
      "every unpriced spot position is declared",
      unmarked.every((row) => pnl.spot.unpriced.includes(row.symbol)),
      unmarked.length === 0 ? "all positions priced" : pnl.spot.unpriced.join(" "),
    );
    check(
      "open spot positions are marked at the prices on screen",
      pnl.spot.positions
        .filter((row) => row.qty > 0 && row.markPrice !== null)
        .every((row) => Number(snapshot.prices?.[row.symbol]) === row.markPrice),
      `${pnl.spot.openCount} open`,
    );

    // The sign test, on live data. A short that reports profit while the mark
    // sits above its entry is the one futures bug that looks plausible on
    // screen, so it is asserted here and not only in the unit tests.
    const wrongWay = pnl.futures.positions.filter((row) => {
      if (row.qty === 0 || row.markPrice === null || row.unrealizedUsd === null) return false;
      const expected = Math.sign((row.markPrice - row.entryPrice) * Math.sign(row.qty));
      return expected !== 0 && Math.sign(row.unrealizedUsd) !== expected;
    });
    check(
      "every futures position has its profit the right way round",
      wrongWay.length === 0,
      `${pnl.futures.longCount} long, ${pnl.futures.shortCount} short`,
    );

    check(
      "futures margin never exceeds its own exposure",
      pnl.futures.positions.every(
        (row) => row.qty === 0 || row.marginUsd <= row.notionalUsd + 1e-9,
      ),
      `$${pnl.futures.marginUsd.toFixed(2)} margin, ${snapshot.maxLeverage}x ceiling`,
    );
  }

  if (!withTick) {
    console.log("\n(pass --tick to drive a live beat and prove the refusal)\n");
  } else {
    console.log("\ntick");
    const beat = await (await fetch(`${base}/api/cron/tick`, { method: "POST" })).json();
    check("a beat completes", beat.ok === true, beat.skipped ?? `${beat.tookMs}ms`);
    if (beat.decision) {
      check(
        "the budget layer ruled on it",
        ["ALLOW", "BLOCK", "REQUIRE_APPROVAL"].includes(beat.decision.decision),
        `${beat.decision.decision}: ${beat.decision.reason}`,
      );
    }

    console.log("\nthe refusal");
    const over = snapshot.limits.maxTradeUsd * 4;
    const blocked = await (
      await fetch(`${base}/api/cron/tick?sizeUsd=${over}`, { method: "POST" })
    ).json();

    if (blocked.skipped) {
      check(`a $${over} trade is refused`, false, `no signal to test against: ${blocked.skipped}`);
    } else {
      check(
        `a $${over} trade is refused`,
        blocked.decision?.decision !== "ALLOW",
        blocked.decision?.reason,
      );
      // The assertion that actually matters. A reason without a refusal is theatre.
      check("and no order reached the exchange", blocked.order === null);
    }
  }

  console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nconsole smoke threw:", err);
  process.exit(1);
});
