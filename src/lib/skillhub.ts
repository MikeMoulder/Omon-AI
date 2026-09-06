/**
 * Binance Skill Hub seam — the `binance-cli` rail.
 *
 * WHY THIS EXISTS. Binance Agent OS publishes two surfaces an agent can read
 * market data through, and only one of them is reachable by an individual
 * developer:
 *
 *   agent.binance.com/mcp/agentic   OAuth, and the client is ALLOWLISTED.
 *                                   Omon's own client_id is refused with
 *                                   `3346001`. See handoff.md.
 *   binance-cli (Skill Hub)         github.com/binance/binance-cli
 *                                   HMAC keys for trading, and NOTHING AT ALL
 *                                   for market data. Not gated.
 *
 * So this file is what makes "built with Binance Agent OS" true in the product
 * rather than aspirational. It sits between MCP and REST in `exchange.ts`: MCP
 * first when a token exists, the Skill Hub CLI next, hand-rolled REST last.
 * Every fall-through is recorded — a silent fallback is the trap in
 * handoff.md section 6.
 *
 * The CLI emits JSON on stdout and exits, so it is a `spawn` away. It is not a
 * long-lived process and there is no session to keep.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLI = process.env.BINANCE_CLI_PATH ?? "binance-cli";
const TIMEOUT_MS = Number(process.env.BINANCE_CLI_TIMEOUT_MS ?? 15_000);

export class SkillHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillHubError";
  }
}

/**
 * Resolve the binary the way a shell would, but without a shell — an absolute
 * or relative path is taken as-is, a bare name is searched along PATH.
 *
 * Cached because `cliMode()` is read on every call in `exchange.ts` (so that a
 * CLI installed while the process is running is picked up without a restart)
 * and stat-ing PATH on every price read would be wasteful. The cache holds the
 * miss too, but only for `MISS_TTL_MS`, which is what keeps a late install from
 * needing a restart.
 */
let resolved: { path: string | null; at: number } | null = null;
const MISS_TTL_MS = 30_000;

function resolveCli(): string | null {
  const now = Date.now();
  if (resolved && (resolved.path !== null || now - resolved.at < MISS_TTL_MS)) {
    return resolved.path;
  }

  let found: string | null = null;
  if (CLI.includes(path.sep) || CLI.startsWith(".")) {
    found = fs.existsSync(CLI) ? CLI : null;
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, CLI);
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }

  resolved = { path: found, at: now };
  return found;
}

/**
 * Which path a Skill Hub read will take, and why. Same contract as `mcpMode()`
 * and `exchangeMode()` so the console can show one honest status line per seam.
 */
export function cliMode(): { mode: "live" | "off"; reason: string } {
  // `DEMO_MODE=fixture` pins the whole app to recorded data. The CLI is a real
  // network call, so it goes off with everything else — with the same escape
  // hatch MCP has, for exercising one rail while the rest stays on fixtures.
  if (process.env.DEMO_MODE === "fixture" && process.env.CLI_IN_FIXTURE_MODE !== "1") {
    return { mode: "off", reason: "DEMO_MODE=fixture" };
  }

  const bin = resolveCli();
  if (!bin) {
    return {
      mode: "off",
      reason: `binance-cli not found (looked for "${CLI}"), install: github.com/binance/binance-cli`,
    };
  }

  return { mode: "live", reason: `binance-cli at ${bin}` };
}

export function cliEnabled(): boolean {
  return cliMode().mode === "live";
}

/**
 * Run `binance-cli` and parse its JSON stdout.
 *
 * `stdin` is IGNORED, deliberately. `exec`/`execFile` leave the child's stdin
 * as an open, unwritten pipe and `binance-cli` blocks reading it — the command
 * only returns promptly when stdin EOFs immediately, as it does under a
 * non-interactive shell. Spawning with stdin ignored is what makes this
 * reliable inside a server process. (Trap confirmed against the CLI's own
 * `-i/--interactive` flag, which is what it is waiting on.)
 */
export async function runCli<T>(args: string[]): Promise<T> {
  const bin = resolveCli();
  if (!bin) throw new SkillHubError(cliMode().reason);

  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new SkillHubError(`binance-cli ${args.join(" ")} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new SkillHubError(`binance-cli failed to start: ${err}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // The CLI reports Binance's own error text on stderr and exits non-zero,
        // so this carries the useful part (e.g. `-1121 Invalid symbol`) rather
        // than just a status code.
        reject(new SkillHubError(`binance-cli exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new SkillHubError(`binance-cli returned non-JSON stdout: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Latest prices for one or many symbols, in ONE process.
 *
 * Use `--json`, not `--symbols`. The flag form
 * `--symbols '["BTCUSDT","BNBUSDT"]'` is rejected by Binance with `-1100
 * Illegal characters found in parameter 'symbols'`, and so are the
 * URL-encoded form the CLI's own `--help` recommends and a bare
 * `BTCUSDT,BNBUSDT` list. `--json '{"symbols":[...]}'` hands the CLI structured
 * input and it serialises the query correctly. All four forms verified against
 * the live API 2026-09-05.
 *
 * That matters beyond tidiness: batching is ~3.3x faster than looping, because
 * the cost here is process spawn, not network. Three symbols measured at 1.96s
 * looped versus 0.60s batched, and the gap widens with every symbol added.
 *
 * SYMBOLS MUST BE UPPERCASE. The server's own regex is
 * `["\w\-._&&[^a-z]]{1,50}"` — a Java character-class intersection meaning
 * "word characters EXCEPT lowercase" — so `btcusdt` is rejected with the same
 * -1100 as a stray space. Upper-cased here rather than trusted from the caller,
 * because the failure looks like a malformed-syntax error rather than a
 * casing one.
 */
export async function cliPrices(symbols: string[]): Promise<Record<string, string>> {
  if (symbols.length === 0) return {};
  const wanted = symbols.map((s) => s.toUpperCase());

  const payload = wanted.length === 1 ? { symbol: wanted[0] } : { symbols: wanted };
  const out = await runCli<{ symbol: string; price: string } | Array<{ symbol: string; price: string }>>(
    ["spot", "ticker-price", "--json", JSON.stringify(payload)],
  );

  // One symbol comes back as an object, many as an array. Normalise both.
  const rows = Array.isArray(out) ? out : [out];
  const prices: Record<string, string> = {};
  for (const row of rows) {
    if (row && typeof row.symbol === "string" && typeof row.price === "string") {
      prices[row.symbol] = row.price;
    }
  }

  const missing = wanted.filter((s) => !(s in prices));
  if (missing.length > 0) {
    throw new SkillHubError(`ticker-price returned no price for ${missing.join(", ")}`);
  }
  return prices;
}

/**
 * Raw kline rows, in the same array-of-arrays shape as `/api/v3/klines` and
 * `spot_klines`. Returned undecoded on purpose: `exchange.ts` owns
 * `decodeKlines()` and all three rails share it, so the indicator maths cannot
 * drift between them. Verified 2026-09-05.
 */
export async function cliKlines(args: {
  symbol: string;
  interval: string;
  limit: number;
}): Promise<unknown[]> {
  const rows = await runCli<unknown[]>([
    "spot",
    "klines",
    "--symbol",
    args.symbol,
    "--interval",
    args.interval,
    "--limit",
    String(args.limit),
  ]);
  if (!Array.isArray(rows)) throw new SkillHubError("klines did not return an array");
  return rows;
}

/** The Skill Hub commands this product actually calls. Published in the manifest. */
export const SKILL_HUB_COMMANDS = {
  prices: "spot ticker-price",
  candles: "spot klines",
} as const;

/**
 * One-shot health check for `/api/agent-os` and `scripts/skillhub-smoke.ts`:
 * is the binary there, what version, and does a credential-free read work.
 */
export async function cliHealth(): Promise<{
  mode: "live" | "off";
  reason: string;
  version?: string;
  error?: string;
}> {
  const { mode, reason } = cliMode();
  if (mode === "off") return { mode, reason };

  try {
    // `--version` prints a bare line, not JSON, so it cannot go through runCli.
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(resolveCli()!, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new SkillHubError("binance-cli --version timed out"));
      }, TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(out.trim());
      });
    });
    return { mode, reason, version };
  } catch (err) {
    return { mode, reason, error: String(err) };
  }
}
