/**
 * Durable storage. The reason a restart no longer erases the product.
 *
 * Everything used to live in process memory — the ledger, both caches, the beat
 * counter — and `pm2 restart omon` threw all of it away: every purchase, every
 * refusal, every fill, and with the fills the entire P&L. The console came back
 * looking like a machine that had never done anything. That is not a caveat, it
 * is a missing feature, and this file is it.
 *
 * ## Files, not a database
 *
 * Two shapes, one directory (`data/`, or `OMON_DATA_DIR`):
 *
 *   append-only  `*.jsonl`  one JSON object per line, oldest first. Events that
 *                           happened and cannot un-happen: purchases, actions,
 *                           fills. Appended with ONE synchronous write per row.
 *   whole doc    `*.json`   state that is replaced rather than accumulated: the
 *                           caches, the beat counter. Written to a temp file and
 *                           renamed, so a kill mid-write cannot leave a half
 *                           document behind.
 *
 * Synchronous appends on purpose. These rows are rare — a handful an hour — and
 * the thing being protected against is the process dying between "the exchange
 * filled the order" and "the row reached the disk". An async write buffered in
 * the event loop is exactly the write a SIGKILL loses, and losing a fill means
 * an open position with no cost basis, which corrupts the P&L rather than just
 * shortening it.
 *
 * SQLite would be the right answer for a real deployment. It is not the right
 * answer for this one: `better-sqlite3` needs a native build on a box where an
 * interrupted npm install has already cost hours (handoff.md trap 1), and the
 * write volume here is roughly one row per five minutes.
 *
 * ## Never fatal
 *
 * A read-only disk, a full disk or a bad `OMON_DATA_DIR` must not stop the tick
 * or fail a paid request. Every operation here catches, flips the store to
 * degraded, and returns false. The app keeps running in memory exactly as it did
 * before — and `storeStatus()` is on the console so "not saving" is visible
 * rather than discovered after the next restart.
 *
 * ## One writer
 *
 * Two processes sharing this directory will interleave appends. Single lines
 * under 4KB with O_APPEND do not tear on Linux, so the file stays parseable, but
 * the two processes will not see each other's rows until they restart. Do not
 * run a second instance — the same rule handoff.md gives for `.mcp-token.json`.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Where the files live, read PER CALL rather than captured at module load.
 *
 * Same convention as `limitsFromEnv()`, and here it is load-bearing rather than
 * stylistic: a static import is evaluated before any test body runs, so a
 * constant captured at load time would ignore an `OMON_DATA_DIR` set afterwards
 * and write test rows into the real `data/`. That happened. Do not turn this
 * back into a const.
 *
 * Default is inside the project so pm2's cwd and a local dev run agree.
 */
function dataDir(): string {
  return process.env.OMON_DATA_DIR ?? path.join(process.cwd(), "data");
}

/** Escape hatch for tests and throwaway instances. Everything stays in memory. */
function enabled(): boolean {
  return process.env.OMON_PERSIST !== "0";
}

/** Directories already created, so mkdir runs once per path and not per write. */
const readyDirs = new Set<string>();
let degradedReason: string | null = null;
let writes = 0;

/** Rows recovered at boot, per collection. Reported on the console. */
const loadedCounts: Record<string, number> = {};
/** Unparseable lines skipped at boot, per collection. Should always be 0 or 1. */
const skippedCounts: Record<string, number> = {};

function degrade(err: unknown): false {
  if (degradedReason === null) {
    degradedReason = err instanceof Error ? err.message : String(err);
    console.error(`[store] persistence is OFF: ${degradedReason}`);
  }
  return false;
}

function ensureDir(): boolean {
  if (!enabled()) return false;
  const dir = dataDir();
  if (readyDirs.has(dir)) return true;
  if (degradedReason !== null) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    readyDirs.add(dir);
    return true;
  } catch (err) {
    return degrade(err);
  }
}

const file = (name: string, ext: string) => path.join(dataDir(), `${name}.${ext}`);

/**
 * Append one event. Returns false when it did not reach the disk, so a caller
 * that cares can say so — none currently do, because the in-memory row is
 * already correct and the console reports the degraded store globally.
 */
export function appendRow(collection: string, row: unknown): boolean {
  if (!ensureDir()) return false;
  try {
    fs.appendFileSync(file(collection, "jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    writes += 1;
    return true;
  } catch (err) {
    return degrade(err);
  }
}

/**
 * Every event ever appended, oldest first.
 *
 * A torn final line — the signature of a kill mid-append — is skipped and
 * counted rather than thrown. One bad row must not cost the other nine hundred.
 */
export function loadRows<T>(collection: string): T[] {
  if (!enabled()) return [];
  const target = file(collection, "jsonl");
  let text: string;
  try {
    if (!fs.existsSync(target)) return [];
    text = fs.readFileSync(target, "utf8");
  } catch (err) {
    degrade(err);
    return [];
  }

  const rows: T[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      skipped += 1;
    }
  }

  loadedCounts[collection] = rows.length;
  if (skipped > 0) {
    skippedCounts[collection] = skipped;
    console.warn(`[store] ${collection}: skipped ${skipped} unparseable line(s)`);
  }
  return rows;
}

/**
 * Replace a whole document, atomically.
 *
 * Temp file plus rename, because the alternative — truncate then write — has a
 * window where the file exists and is empty. A crash inside that window loses
 * the cache it was trying to save, which is precisely the failure this file is
 * here to prevent.
 */
export function writeDoc(name: string, doc: unknown): boolean {
  if (!ensureDir()) return false;
  const target = file(name, "json");
  const temp = `${target}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(doc), "utf8");
    fs.renameSync(temp, target);
    writes += 1;
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best effort. A stray .tmp is harmless; nothing ever reads one.
    }
    return degrade(err);
  }
}

/** The document, or null when absent or unreadable. Never throws. */
export function readDoc<T>(name: string): T | null {
  if (!enabled()) return null;
  const target = file(name, "json");
  try {
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, "utf8")) as T;
  } catch (err) {
    // A corrupt document is recoverable — the caller starts cold — so this
    // warns rather than degrading the whole store.
    console.warn(`[store] ${name}.json unreadable, starting cold:`, err);
    return null;
  }
}

export type StoreStatus = {
  dir: string;
  /** True when rows are reaching the disk. False means this process is amnesiac. */
  persisting: boolean;
  /** Why persistence is off, when it is. */
  error: string | null;
  /** Rows recovered from disk at boot, per collection. */
  loaded: Record<string, number>;
  /** Lines that would not parse at boot. Non-zero deserves a look. */
  skipped: Record<string, number>;
  /** Writes since this process started. */
  writes: number;
};

/**
 * What the console shows about storage.
 *
 * `persisting` is deliberately conservative: it is only true once a directory
 * has actually been created and no write has failed. A screen that claims to be
 * saving when it is not is worse than one that says nothing.
 */
export function storeStatus(): StoreStatus {
  const dir = dataDir();
  return {
    dir,
    persisting: enabled() && readyDirs.has(dir) && degradedReason === null,
    error: enabled() ? degradedReason : "OMON_PERSIST=0",
    loaded: { ...loadedCounts },
    skipped: { ...skippedCounts },
    writes,
  };
}

/**
 * Create the directory now rather than on the first write.
 *
 * Called by the ledger at hydrate time so `persisting` is true on the very first
 * console frame, instead of flipping to true only after something happened to
 * save. A box with a broken data directory should say so immediately.
 */
export function initStore(): void {
  ensureDir();
}
