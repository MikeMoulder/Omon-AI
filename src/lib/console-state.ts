/**
 * One snapshot of everything the console shows, built in one place.
 *
 * The screen is the only thing a judge and a viewer actually look at, so its
 * data source has one rule above all others: **it must be cheap enough to build
 * every two seconds.** Anything that spawns a process, calls a model or waits on
 * a network round trip is either excluded or cached here — a status panel that
 * quietly hammers Binance while the video records is worse than no panel.
 *
 * That is why the Agent OS row uses `mcpMode()` and `cliMode()`, which read
 * configuration synchronously, rather than `mcpHealth()` and `cliHealth()`,
 * which each go and ask. `/api/agent-os` is still the deep check, and the two
 * agree because they read the same functions underneath.
 *
 * Balances are the one genuine network read, behind a 15 second cache and never
 * awaited on a failure path: an exchange hiccup greys the number out, it does
 * not stall the stream.
 */
import type { Action, Intel, Purchase, Signal } from "@/lib/types";
import { limitsFromEnv, type BudgetLimits } from "@/lib/budget";
import { exchangeMode, getBalances } from "@/lib/exchange";
import { getIntel, intelCacheStatus, type CacheStatus } from "@/lib/intel-cache";
import { getSignals, signalCacheStatus, type SignalCacheStatus } from "@/lib/signal-cache";
import { actions, ledgerSummary, purchases, type LedgerSummary } from "@/lib/ledger";
import { llmMode } from "@/lib/llm";
import { mcpMode, mcpUsage } from "@/lib/mcp";
import { newsMode } from "@/lib/news";
import { cliMode } from "@/lib/skillhub";
import { SERVICE_NAME, SERVICE_DESCRIPTION } from "@/lib/service";
import { network, price, priceToken, rail } from "@/lib/x402";

type Mode = { mode: string; reason: string };

export type ConsoleSnapshot = {
  at: string;
  service: { name: string; description: string };
  /** One honest line per seam. The console renders these as status pills. */
  seams: {
    intelAgent: Mode;
    signalAgent: Mode;
    news: Mode;
    exchange: Mode;
    mcp: Mode;
    skillHub: Mode;
  };
  payment: { rail: string; network: string; price: string; token: string };
  intel: { rows: Intel[]; status: CacheStatus; source: "cache" | "fixture" };
  signals: { rows: Signal[]; status: SignalCacheStatus; source: "cache" | "empty" };
  money: { in: Purchase[]; out: Action[] };
  ledger: LedgerSummary;
  limits: BudgetLimits;
  /** Spot Demo Mode balances — the account orders actually hit. Null while unreadable. */
  balances: Record<string, string> | null;
  balancesError: string | null;
  /** Which rail each market read last used, written by src/lib/exchange.ts. */
  usage: ReturnType<typeof mcpUsage>;
};

const BALANCE_TTL_MS = Number(process.env.CONSOLE_BALANCE_TTL_MS ?? 15_000);

let balanceRows: Record<string, string> | null = null;
let balanceError: string | null = null;
let balanceAt = 0;
let balanceInflight: Promise<void> | null = null;

/**
 * Refresh balances at most once per TTL, and never let two refreshes overlap.
 *
 * Awaited rather than fired and forgotten so the first snapshot after a cold
 * start already carries a number — a balance that appears a beat late is the
 * one thing the demo cannot afford, since the payment moment is the balance
 * moving.
 */
async function balances(): Promise<void> {
  if (Date.now() - balanceAt < BALANCE_TTL_MS) return;
  if (balanceInflight) return balanceInflight;

  balanceInflight = getBalances()
    .then((rows) => {
      balanceRows = rows;
      balanceError = null;
    })
    .catch((err) => {
      // Keep the last good rows on screen and say why they stopped updating,
      // rather than blanking a number the viewer was watching.
      balanceError = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      balanceAt = Date.now();
      balanceInflight = null;
    });

  return balanceInflight;
}

export async function consoleSnapshot(): Promise<ConsoleSnapshot> {
  await balances();

  const intel = getIntel(8);
  const signals = getSignals(8);

  return {
    at: new Date().toISOString(),
    service: { name: SERVICE_NAME, description: SERVICE_DESCRIPTION },
    seams: {
      intelAgent: llmMode("intel"),
      signalAgent: llmMode("signal"),
      news: newsMode(),
      exchange: exchangeMode(),
      mcp: mcpMode(),
      skillHub: cliMode(),
    },
    payment: { rail, network, price, token: priceToken },
    intel: { rows: intel.intel, status: intelCacheStatus(), source: intel.source },
    signals: { rows: signals.signals, status: signalCacheStatus(), source: signals.source },
    money: { in: purchases(12), out: actions(12) },
    ledger: ledgerSummary(),
    limits: limitsFromEnv(),
    balances: balanceRows,
    balancesError: balanceError,
    usage: mcpUsage(),
  };
}
