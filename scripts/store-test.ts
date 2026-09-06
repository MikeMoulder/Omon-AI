/**
 * Tests for durable storage — the answer to "upon pm2 restart, everything
 * restarted".
 *   npx tsx scripts/store-test.ts
 *
 * No network, no keys, no model. Runs against throwaway directories under the
 * OS temp dir and never touches the real `data/`.
 *
 * ## The restarts are real processes, on purpose
 *
 * The first version of this file faked a restart by clearing `require.cache`
 * and re-importing. It did not work — tsx keeps its own registry for dynamic
 * import, the module was never re-executed, and the test happily asserted
 * against the same in-memory arrays it had just written to. It would have
 * passed with persistence entirely removed.
 *
 * So the restart cases spawn a second `tsx` process against the same data
 * directory. That is what `pm2 restart omon` does, and it is the only version of
 * this test that can fail for the right reason. It costs a few seconds.
 *
 * Phases are dispatched by `--phase`; the parent runs each child and asserts on
 * its exit code, so a failed assertion in a child fails the suite.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendRow, loadRows, readDoc, storeStatus, writeDoc } from "@/lib/store";
import {
  actions,
  earnedTodayUsd,
  fills,
  hasTradedSignal,
  ledgerSummary,
  purchases,
  recordAction,
  recordFill,
  recordPurchase,
  spentTodayUsd,
} from "@/lib/ledger";
import { computePnl } from "@/lib/pnl";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const order = (over: { orderId?: string; qty?: string; quote?: string } = {}) => ({
  orderId: over.orderId ?? "ord_1",
  symbol: "BTCUSDT",
  side: "BUY" as const,
  status: "FILLED",
  executedQty: over.qty ?? "0.0001",
  cummulativeQuoteQty: over.quote ?? "9.00",
  transactTime: Date.now(),
  live: true,
});

// ---------------------------------------------------------------- child phases

/**
 * What a first run does: a purchase, an allowed trade that filled, a refusal,
 * and a trade whose order filled nothing. One of each row the ledger holds.
 */
function phaseWrite(): void {
  recordPurchase({
    endpoint: "/api/intel",
    buyerAddr: "0xabc",
    amount: "0.01",
    token: "USDC",
    txHash: "0xdead",
  });

  const allowed = recordAction({
    kind: "trade",
    payload: { symbol: "BTCUSDT", side: "BUY", sizeUsd: 24, signalId: "sig_42" },
    decision: "ALLOW",
    reason: "within limits",
    orderId: "ord_1",
  });
  recordFill({ actionId: allowed.id, order: order() });

  recordAction({
    kind: "trade",
    payload: { symbol: "BTCUSDT", side: "BUY", sizeUsd: 99 },
    decision: "BLOCK",
    reason: "$99.00 exceeds the $25 per-trade cap",
    orderId: null,
  });

  const empty = recordAction({
    kind: "trade",
    payload: { symbol: "ETHUSDT", side: "BUY", sizeUsd: 9 },
    decision: "ALLOW",
    reason: "within limits",
    orderId: "ord_2",
  });
  assert.equal(
    recordFill({ actionId: empty.id, order: order({ orderId: "ord_2", qty: "0" }) }),
    null,
    "an order that filled nothing is not a fill",
  );
}

/** What the SECOND process must see. Every assertion here is the whole point. */
function phaseRead(): void {
  assert.equal(purchases().length, 1, "the purchase came back");
  assert.ok(Math.abs(earnedTodayUsd() - 0.01) < 1e-9, "and so did 24h revenue");

  assert.equal(actions().length, 3, "both trades and the refusal came back");
  assert.equal(fills().length, 1, "the fill came back; the empty order did not");

  const summary = ledgerSummary();
  assert.equal(summary.blockedCount, 1, "the refusal is still on the record");
  assert.equal(summary.fillCount, 1);

  assert.equal(spentTodayUsd(), 33, "a restart must not hand back spending room");
  assert.equal(hasTradedSignal("sig_42"), true, "or the same idea is bought twice");
  assert.equal(hasTradedSignal("sig_other"), false);

  // 0.0001 BTC cost $9, worth $10 at 100,000 — the P&L survived the restart.
  const pnl = computePnl(fills(), { BTCUSDT: "100000" });
  assert.equal(pnl.openCount, 1);
  assert.ok(Math.abs(pnl.totalUsd - 1) < 0.005, `P&L survived: ${pnl.totalUsd}`);
}

/** Reads back after a line was duplicated by hand. Must not double the position. */
function phaseDeduped(): void {
  assert.equal(fills().length, 1, "deduped by id");
  const pnl = computePnl(fills(), { BTCUSDT: "100000" });
  assert.ok(Math.abs(pnl.totalUsd - 1) < 0.005, "and the position is not doubled");
}

/** A directory that cannot be created. The app must run on, saying so. */
function phaseUnwritable(): void {
  assert.equal(appendRow("things", { id: "a" }), false);
  const status = storeStatus();
  assert.equal(status.persisting, false);
  assert.ok(status.error, "a degraded store must say why");
  assert.deepEqual(loadRows("things"), []);

  // The ledger still works, in memory, exactly as it did before this feature.
  recordPurchase({
    endpoint: "/api/intel",
    buyerAddr: "0xabc",
    amount: "0.01",
    token: "USDC",
    txHash: "0xdead",
  });
  assert.equal(purchases().length, 1, "an unwritable disk must not break the ledger");
}

/** The opt-out. Everything in memory, and the console told so. */
function phaseDisabled(): void {
  assert.equal(appendRow("things", { id: "a" }), false);
  assert.equal(storeStatus().persisting, false);
  assert.equal(storeStatus().error, "OMON_PERSIST=0");
  recordAction({
    kind: "trade",
    payload: { symbol: "BTCUSDT", side: "BUY", sizeUsd: 9 },
    decision: "ALLOW",
    reason: "within limits",
    orderId: "ord_1",
  });
  assert.equal(actions().length, 1, "still works, just not saved");
}

const PHASES: Record<string, () => void> = {
  write: phaseWrite,
  read: phaseRead,
  deduped: phaseDeduped,
  unwritable: phaseUnwritable,
  disabled: phaseDisabled,
};

// ------------------------------------------------------------------ the parent

/**
 * Run one phase in a REAL second process. Throws with the child's output.
 *
 * Spawned through tsx rather than bare node: this file is TypeScript and imports
 * through the `@/` alias, neither of which plain `node` can resolve.
 */
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

function spawnPhase(phase: string, env: Record<string, string>): void {
  try {
    execFileSync(TSX, [__filename, "--phase", phase], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`phase "${phase}" failed:\n${e.stderr ?? ""}${e.stdout ?? ""}`);
  }
}

function main(): void {
  const phaseArg = process.argv.indexOf("--phase");
  if (phaseArg !== -1) {
    PHASES[process.argv[phaseArg + 1]]();
    return;
  }

  console.log("\nstore — files");

  // Set BEFORE the first store call, never before the import — the import is
  // hoisted and runs first. src/lib/store.ts reads this per call precisely so
  // this works; an earlier version captured it at load and wrote the test's rows
  // into the real data/ directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omon-store-"));
  process.env.OMON_DATA_DIR = dir;

  check("the store writes where it is told, not where it was born", () => {
    assert.equal(storeStatus().dir, dir);
  });

  check("a cold directory reports persisting once written to", () => {
    appendRow("warmup", { id: "w" });
    const status = storeStatus();
    assert.equal(status.persisting, true, status.error ?? "");
    assert.equal(status.error, null);
  });

  check("rows append and load back oldest first", () => {
    appendRow("things", { id: "a" });
    appendRow("things", { id: "b" });
    assert.deepEqual(loadRows("things"), [{ id: "a" }, { id: "b" }]);
  });

  check("a torn final line is skipped, not thrown", () => {
    // Exactly what a SIGKILL mid-append leaves behind.
    fs.appendFileSync(path.join(dir, "things.jsonl"), '{"id":"c",{bro');
    assert.deepEqual(loadRows("things"), [{ id: "a" }, { id: "b" }]);
    assert.equal(storeStatus().skipped.things, 1);
  });

  check("a document round-trips", () => {
    writeDoc("doc", { rows: [1, 2, 3], refreshedAt: 42 });
    assert.deepEqual(readDoc("doc"), { rows: [1, 2, 3], refreshedAt: 42 });
  });

  check("a corrupt document starts cold instead of throwing", () => {
    fs.writeFileSync(path.join(dir, "doc.json"), "{not json");
    assert.equal(readDoc("doc"), null);
  });

  check("a whole-doc write leaves no temp file behind", () => {
    writeDoc("doc2", { ok: true });
    assert.equal(fs.existsSync(path.join(dir, "doc2.json.tmp")), false);
  });

  console.log("\nthe ledger, across a REAL restart");

  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "omon-ledger-"));

  check("a first process writes purchases, trades, refusals and fills", () => {
    spawnPhase("write", { OMON_DATA_DIR: ledgerDir });
    assert.ok(fs.existsSync(path.join(ledgerDir, "fills.jsonl")), "fills reached the disk");
  });

  check("a SECOND process sees all of it — money, leash and P&L", () => {
    spawnPhase("read", { OMON_DATA_DIR: ledgerDir });
  });

  check("a duplicated append cannot double a position", () => {
    const target = path.join(ledgerDir, "fills.jsonl");
    const lines = fs.readFileSync(target, "utf8").trim().split("\n");
    fs.appendFileSync(target, `${lines[lines.length - 1]}\n`);
    spawnPhase("deduped", { OMON_DATA_DIR: ledgerDir });
  });

  console.log("\nwhen the disk will not take it");

  check("an unwritable directory degrades instead of crashing", () => {
    // A directory under a FILE, so mkdir fails with ENOTDIR immediately. Not
    // /proc — mkdir there hangs rather than erroring in some sandboxes, and a
    // test that hangs is worse than the bug it was looking for.
    spawnPhase("unwritable", { OMON_DATA_DIR: "/dev/null/omon-data" });
  });

  check("OMON_PERSIST=0 keeps everything in memory and says so", () => {
    spawnPhase("disabled", { OMON_DATA_DIR: ledgerDir, OMON_PERSIST: "0" });
  });

  console.log(`\n${passed} passed\n`);
}

main();
