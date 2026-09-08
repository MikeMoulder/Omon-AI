/**
 * Which Binance products are reachable without real money.
 *
 *   npx tsx scripts/agent-os-matrix.ts
 *   npx tsx scripts/agent-os-matrix.ts --verbose
 *
 * Track B asks for three trades: spot, futures, and margin-or-convert. Two of
 * those three products have no non-production path in Binance's own official
 * Skill Hub CLI, and this script is the probe that establishes it.
 *
 * `binance-cli` takes BINANCE_API_ENV=prod|testnet|demo, but the accepted set is
 * per product, not global. Ask Convert or Margin for a demo environment and the
 * CLI refuses before a request is ever made:
 *
 *     Error: Invalid api env, valid values: prod
 *
 * That is a client-side refusal, so no credential can work around it. Completing
 * Track B's third task therefore requires a funded production account. Spot and
 * futures do not — both accept demo and testnet, which is why Omon trades on
 * them and why the total real money moved by this project is $0.
 *
 * This script is not a pass/fail on Omon. It exits non-zero only if a rail the
 * product actually depends on has stopped working. The prod-only rows are the
 * finding, and they are expected.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

import { spawn } from "node:child_process";

const verbose = process.argv.includes("--verbose");
const CLI = process.env.BINANCE_CLI_PATH ?? "binance-cli";
const ENVS = ["demo", "testnet", "prod"] as const;
type Env = (typeof ENVS)[number];

/** How a product answered a read-only probe in one environment. */
type Result = "OK" | "REFUSED" | "AUTH" | "ERR";

type Probe = {
  product: string;
  /** A read-only subcommand. Nothing here places an order or moves a balance. */
  args: string[];
  /** True if Omon's trading path depends on this product working off-prod. */
  loadBearing: boolean;
};

const PROBES: Probe[] = [
  { product: "spot", args: ["spot", "ticker-price", "--symbol", "BNBUSDT"], loadBearing: true },
  {
    product: "futures-usds",
    args: ["futures-usds", "symbol-price-ticker", "--symbol", "BNBUSDT"],
    loadBearing: true,
  },
  {
    product: "convert",
    args: ["convert", "list-all-convert-pairs", "--from-asset", "BNB", "--to-asset", "USDT"],
    loadBearing: false,
  },
  {
    product: "margin-trading",
    args: ["margin-trading", "query-margin-priceindex", "--symbol", "BNBUSDT"],
    loadBearing: false,
  },
  { product: "wallet", args: ["wallet", "account-status"], loadBearing: false },
];

/**
 * Run one probe.
 *
 * `stdio: ["ignore", ...]` is not a style choice. `binance-cli` blocks reading
 * stdin, so leaving it as an open unwritten pipe hangs the child forever with no
 * output. See src/lib/skillhub.ts, which pays for the same lesson.
 */
function probe(args: string[], env: Env): Promise<{ result: Result; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BINANCE_API_ENV: env },
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ result: "ERR", text: "timed out" });
    }, 25_000);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ result: "ERR", text: String(e) });
    });

    child.on("exit", () => {
      clearTimeout(timer);
      const text = (err.trim() || out.trim()).replace(/\s+/g, " ").slice(0, 160);

      // Order matters: the env refusal is client-side and happens before any
      // credential is considered, so it must be classified before auth errors.
      if (/Invalid api env/i.test(text)) return resolve({ result: "REFUSED", text });
      if (/Api-Key|API-key|api-key/i.test(text)) return resolve({ result: "AUTH", text });
      if (/^Error/i.test(text) || /error/i.test(err)) return resolve({ result: "ERR", text });
      return resolve({ result: "OK", text });
    });
  });
}

const CELL: Record<Result, string> = {
  OK: "  ok   ",
  REFUSED: "REFUSED",
  AUTH: " auth  ",
  ERR: "  err  ",
};

async function main(): Promise<void> {
  console.log("\nBinance product x API environment — what is reachable without real funds");
  console.log(`probing with ${CLI}\n`);
  console.log(`${"PRODUCT".padEnd(16)}${ENVS.map((e) => e.padEnd(9)).join("")}`);
  console.log("-".repeat(16 + ENVS.length * 9));

  let failures = 0;
  const prodOnly: string[] = [];

  for (const p of PROBES) {
    const cells: string[] = [];
    const results: Record<string, Result> = {};

    for (const env of ENVS) {
      const { result, text } = await probe(p.args, env);
      results[env] = result;
      cells.push(CELL[result].padEnd(9));
      if (verbose && result !== "OK") console.log(`    ${p.product}/${env}: ${text}`);
    }

    console.log(`${p.product.padEnd(16)}${cells.join("")}`);

    // A rail the strategy runs on must work off-prod, or Omon cannot trade
    // without real money and the $0 claim in the README is no longer true.
    if (p.loadBearing && !(results.demo === "OK" && results.testnet === "OK")) {
      failures += 1;
      console.log(`    FAIL — ${p.product} is load-bearing and is not reachable off prod`);
    }

    if (results.demo === "REFUSED" && results.testnet === "REFUSED") prodOnly.push(p.product);
  }

  console.log("\nfinding");
  if (prodOnly.length > 0) {
    console.log(`  prod-only, refused client-side off prod: ${prodOnly.join(", ")}`);
    console.log("  Track B's margin-or-convert task cannot be completed without a funded");
    console.log("  production account. No credential works around a client-side refusal.");
  } else {
    console.log("  no product refused a non-production environment.");
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} load-bearing rail(s) down`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
