/**
 * Budget layer. Plain code, no model, no network.
 *
 * This is the boundary between what the Signal Agent *proposes* and what
 * actually reaches Binance. The LLM never sees these limits and cannot raise
 * them — the numbers come from the environment, and every trade is checked
 * here before execution. A model that hallucinates a $10,000 position gets the
 * same treatment as one that behaves.
 *
 * Model output is untrusted input. Treat `sizeUsd` as hostile.
 */
import type { Decision } from "@/lib/types";
import { MIN_NOTIONAL_USD } from "@/lib/exchange";

export type BudgetLimits = {
  /** Hard ceiling on any single trade. */
  maxTradeUsd: number;
  /** Ceiling on everything traded in a rolling 24h. */
  dailyTradeUsd: number;
  /** Only these pairs may ever be traded. */
  allowedSymbols: string[];
  /** Trades above this need a human. Set at or above maxTradeUsd to disable. */
  requireApprovalAboveUsd: number;
};

const DEFAULTS: BudgetLimits = {
  maxTradeUsd: 25,
  dailyTradeUsd: 100,
  allowedSymbols: ["BNBUSDT", "BTCUSDT", "ETHUSDT"],
  requireApprovalAboveUsd: 25,
};

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Limits as configured. Read per call so a redeploy is not needed to change them. */
export function limitsFromEnv(): BudgetLimits {
  const symbols = (process.env.BUDGET_ALLOWED_SYMBOLS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return {
    maxTradeUsd: num(process.env.BUDGET_MAX_TRADE_USD, DEFAULTS.maxTradeUsd),
    dailyTradeUsd: num(process.env.BUDGET_DAILY_TRADE_USD, DEFAULTS.dailyTradeUsd),
    allowedSymbols: symbols.length > 0 ? symbols : DEFAULTS.allowedSymbols,
    requireApprovalAboveUsd: num(
      process.env.BUDGET_REQUIRE_APPROVAL_ABOVE_USD,
      DEFAULTS.requireApprovalAboveUsd,
    ),
  };
}

/**
 * Decide whether a proposed trade may execute.
 *
 * Checks run cheapest-and-most-absolute first, so the reason returned is always
 * the most fundamental thing wrong rather than whichever rule happened to run.
 */
export function evaluateTrade(args: {
  symbol: string;
  sizeUsd: number;
  /** Sum of quote currency already spent in the current window. */
  spentTodayUsd: number;
  limits?: BudgetLimits;
}): Decision {
  const limits = args.limits ?? limitsFromEnv();
  const spent = Math.max(0, args.spentTodayUsd);
  const remainingUsd = Math.max(0, limits.dailyTradeUsd - spent);
  const symbol = args.symbol?.toUpperCase() ?? "";

  const block = (reason: string): Decision => ({ decision: "BLOCK", reason, remainingUsd });

  // A model can emit NaN, Infinity, a negative, or a string that coerced badly.
  if (!Number.isFinite(args.sizeUsd) || args.sizeUsd <= 0) {
    return block(`size ${String(args.sizeUsd)} is not a positive number`);
  }

  if (!limits.allowedSymbols.includes(symbol)) {
    return block(`${symbol || "(no symbol)"} is not on the allowlist`);
  }

  if (args.sizeUsd < MIN_NOTIONAL_USD) {
    return block(`$${args.sizeUsd.toFixed(2)} is below the $${MIN_NOTIONAL_USD} exchange minimum`);
  }

  if (args.sizeUsd > limits.maxTradeUsd) {
    return block(
      `$${args.sizeUsd.toFixed(2)} exceeds the $${limits.maxTradeUsd} per-trade cap`,
    );
  }

  if (spent + args.sizeUsd > limits.dailyTradeUsd) {
    return block(
      `$${args.sizeUsd.toFixed(2)} would exceed the $${limits.dailyTradeUsd} daily cap ` +
        `($${remainingUsd.toFixed(2)} left)`,
    );
  }

  if (args.sizeUsd > limits.requireApprovalAboveUsd) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `$${args.sizeUsd.toFixed(2)} is above the $${limits.requireApprovalAboveUsd} auto-approve threshold`,
      remainingUsd,
    };
  }

  return {
    decision: "ALLOW",
    reason: `within limits — $${remainingUsd.toFixed(2)} of today's $${limits.dailyTradeUsd} remaining`,
    remainingUsd,
  };
}

/**
 * How much has been spent in the current window.
 *
 * Derived from the action log rather than kept as its own counter, so there is
 * no second number that can disagree with what actually happened. Only trades
 * that were allowed and produced an order count against the budget.
 */
export function spentToday(
  actions: Array<{
    kind: string;
    decision: string;
    orderId: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>,
  now = Date.now(),
): number {
  const windowStart = now - 24 * 60 * 60 * 1000;

  return actions
    .filter((a) => a.kind === "trade" && a.decision === "ALLOW" && a.orderId !== null)
    .filter((a) => new Date(a.createdAt).getTime() >= windowStart)
    .reduce((total, a) => {
      const size = Number(a.payload?.sizeUsd);
      return Number.isFinite(size) && size > 0 ? total + size : total;
    }, 0);
}
