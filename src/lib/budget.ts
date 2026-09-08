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
 *
 * ## Two rules added with futures and spot sells
 *
 * **1. Closing is never blocked by the spending cap.** The daily cap counts
 * trades that INCREASE exposure and exempts the ones that reduce it. This is a
 * safety property, not a loophole: a cap that also throttles exits can leave the
 * agent holding a position it is forbidden to close, which is a strictly more
 * dangerous state than the one the cap was protecting against. An agent must
 * always be able to get out.
 *
 * **2. `sizeUsd` means notional on both venues.** On futures, $20 at 3x posts
 * about $6.67 of margin and carries $20 of exposure. The cap is checked against
 * the $20, so "$100 a day" means the same sentence on both venues and leverage
 * cannot quietly multiply it. Margin is reported alongside, never instead.
 */
import type { Decision, GateCheck, Venue } from "@/lib/types";
import { MIN_NOTIONAL_USD } from "@/lib/exchange";
import { MAX_LEVERAGE, futuresEnabled } from "@/lib/futures";

export type BudgetLimits = {
  /** Hard ceiling on any single trade. */
  maxTradeUsd: number;
  /** Ceiling on everything traded in a rolling 24h. */
  dailyTradeUsd: number;
  /** Only these pairs may ever be traded. */
  allowedSymbols: string[];
  /** Trades above this need a human. Set at or above maxTradeUsd to disable. */
  requireApprovalAboveUsd: number;
  /** Hard ceiling on futures leverage. Mirrors src/lib/futures.ts MAX_LEVERAGE. */
  maxLeverage: number;
};

const DEFAULTS: BudgetLimits = {
  maxTradeUsd: 25,
  dailyTradeUsd: 100,
  allowedSymbols: ["BNBUSDT", "BTCUSDT", "ETHUSDT"],
  requireApprovalAboveUsd: 25,
  maxLeverage: 3,
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
    // Read from the futures seam rather than its own env var, so there is one
    // number and not two that can disagree about what the ceiling is.
    maxLeverage: MAX_LEVERAGE,
  };
}

/**
 * Does this trade add exposure, or take it off?
 *
 * The distinction the daily cap turns on. A spot SELL and a reduce-only futures
 * order both shrink a position; everything else grows one.
 */
export function isClosing(args: {
  venue?: Venue;
  side?: "BUY" | "SELL";
  reduceOnly?: boolean;
}): boolean {
  if (args.reduceOnly) return true;
  // Spot cannot go short, so a spot SELL is always a close.
  return (args.venue ?? "spot") === "spot" && args.side === "SELL";
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
  /** Sum of quote currency already committed in the current window. */
  spentTodayUsd: number;
  limits?: BudgetLimits;
  /** Which market. Defaults to spot, which is what every pre-futures caller meant. */
  venue?: Venue;
  /** Defaults to BUY, so existing callers keep their exact behaviour. */
  side?: "BUY" | "SELL";
  /** Futures only. Checked against the leverage ceiling. */
  leverage?: number;
  /** Futures only. A close, which the daily cap does not throttle. */
  reduceOnly?: boolean;
  /**
   * Market value of what Omon's own fills say it holds in this symbol.
   *
   * Required to sell on spot, and the reason is not bookkeeping: a spot account
   * cannot short, so a SELL for more than is held is not a bearish trade, it is
   * an order that will bounce off the exchange with -2010. Blocking it here
   * turns a confusing exchange error into a stated refusal, which is the whole
   * job of this file. Undefined means "caller did not look", and a sell is
   * refused rather than attempted on an unknown position.
   */
  holdingUsd?: number;
  /**
   * The smallest notional this symbol will actually accept, when the caller
   * knows better than the flat exchange floor.
   *
   * Futures minimums are per symbol and some of them are large: BTCUSDT wants
   * $50 of notional, which is above the default $25 per-trade cap, so BTC perps
   * are simply not tradable at that cap. Passing the real number in turns that
   * from an exchange rejection after the fact into a stated refusal before it,
   * which is the entire job of this file.
   */
  minNotionalUsd?: number;
}): Decision {
  const limits = args.limits ?? limitsFromEnv();
  const spent = Math.max(0, args.spentTodayUsd);
  const remainingUsd = Math.max(0, limits.dailyTradeUsd - spent);
  const symbol = args.symbol?.toUpperCase() ?? "";
  const venue: Venue = args.venue ?? "spot";
  const side = args.side ?? "BUY";
  const closing = isClosing({ venue, side, reduceOnly: args.reduceOnly });

  // The trace. Numbers come from position rather than being hardcoded, so a
  // check inserted in the middle renumbers everything after it automatically
  // and the console never shows a gap. Skips are recorded, not dropped, which
  // is what keeps the numbering identical across every trade.
  const checks: GateCheck[] = [];
  const next = () => checks.length + 1;

  /** This check let the trade through. */
  const pass = (name: string, detail?: string): void => {
    checks.push({ n: next(), name, status: "pass", ...(detail ? { detail } : {}) });
  };

  /** This check did not apply — a futures rule on a spot order, say. */
  const skip = (name: string, detail: string): void => {
    checks.push({ n: next(), name, status: "skip", detail });
  };

  /** This check refused. Records it and returns the refusal. */
  const block = (name: string, reason: string): Decision => {
    checks.push({ n: next(), name, status: "fail", detail: reason });
    return { decision: "BLOCK", reason, remainingUsd, checks };
  };

  // A model can emit NaN, Infinity, a negative, or a string that coerced badly.
  if (!Number.isFinite(args.sizeUsd) || args.sizeUsd <= 0) {
    return block("size is a positive number", `size ${String(args.sizeUsd)} is not a positive number`);
  }
  pass("size is a positive number", `$${args.sizeUsd.toFixed(2)}`);

  if (!limits.allowedSymbols.includes(symbol)) {
    return block("symbol is on the allowlist", `${symbol || "(no symbol)"} is not on the allowlist`);
  }
  pass("symbol is on the allowlist", symbol);

  // Venue gate before anything venue-specific, so a futures order on a build
  // with futures switched off is refused for the reason it was actually
  // refused, rather than passing every check and failing at the exchange.
  if (venue === "futures" && !futuresEnabled()) {
    return block("venue is enabled", "futures is switched off: set FUTURES_ENABLED=1");
  }
  pass("venue is enabled", venue);

  if (venue === "futures") {
    const leverage = args.leverage ?? 1;
    if (!Number.isFinite(leverage) || leverage < 1) {
      return block("leverage within ceiling", `leverage ${String(args.leverage)} is not a valid multiplier`);
    }
    if (leverage > limits.maxLeverage) {
      return block(
        "leverage within ceiling",
        `${leverage}x exceeds the ${limits.maxLeverage}x leverage ceiling`,
      );
    }
    pass("leverage within ceiling", `${leverage}x of ${limits.maxLeverage}x`);
  } else {
    skip("leverage within ceiling", "spot does not lever");
  }

  // Spot cannot borrow. Selling more than is held is not a short, it is an
  // order that bounces.
  if (venue === "spot" && side === "SELL") {
    const held = args.holdingUsd;
    if (held === undefined || !Number.isFinite(held) || held <= 0) {
      return block(
        "spot sell is covered",
        `nothing to sell: Omon holds no ${symbol.replace("USDT", "")} of its own`,
      );
    }
    if (args.sizeUsd > held) {
      return block(
        "spot sell is covered",
        `$${args.sizeUsd.toFixed(2)} is more ${symbol.replace("USDT", "")} than Omon holds ` +
          `($${held.toFixed(2)} worth)`,
      );
    }
    pass("spot sell is covered", `$${held.toFixed(2)} held`);
  } else {
    skip("spot sell is covered", venue === "futures" ? "futures can short" : "not a sell");
  }

  const floor = Math.max(MIN_NOTIONAL_USD, args.minNotionalUsd ?? 0);

  // A floor above the ceiling first, because it is the more fundamental fact:
  // this symbol cannot be traded here at ANY size, which is a different problem
  // from this particular size being too small, and it is the one the operator
  // has to fix. Both are true of a $25 trade on a symbol with a $50 floor, and
  // "raise the cap or drop the symbol" is more use than "try a bigger number".
  if (floor > limits.maxTradeUsd) {
    return block(
      "symbol is tradable at this cap",
      `${symbol} needs $${floor.toFixed(2)} minimum on ${venue}, above the ` +
        `$${limits.maxTradeUsd} per-trade cap`,
    );
  }
  pass("symbol is tradable at this cap", `floor $${floor.toFixed(2)} <= cap $${limits.maxTradeUsd}`);

  if (args.sizeUsd < floor) {
    return block(
      "size meets the symbol minimum",
      `$${args.sizeUsd.toFixed(2)} is below the $${floor.toFixed(2)} minimum for ${symbol}` +
        (venue === "futures" ? " on futures" : ""),
    );
  }
  pass("size meets the symbol minimum", `$${floor.toFixed(2)} floor`);

  if (args.sizeUsd > limits.maxTradeUsd) {
    return block(
      "size within per-trade cap",
      `$${args.sizeUsd.toFixed(2)} exceeds the $${limits.maxTradeUsd} per-trade cap`,
    );
  }
  pass("size within per-trade cap", `$${limits.maxTradeUsd} cap`);

  // See the header: closes are exempt. An agent that cannot exit because it hit
  // its own spending cap is in a worse position than one that never traded.
  if (!closing && spent + args.sizeUsd > limits.dailyTradeUsd) {
    return block(
      "within daily spend cap",
      `$${args.sizeUsd.toFixed(2)} would exceed the $${limits.dailyTradeUsd} daily cap ` +
        `($${remainingUsd.toFixed(2)} left)`,
    );
  }
  if (closing) {
    skip("within daily spend cap", "closes are exempt");
  } else {
    pass("within daily spend cap", `$${remainingUsd.toFixed(2)} of $${limits.dailyTradeUsd} left`);
  }

  if (args.sizeUsd > limits.requireApprovalAboveUsd) {
    checks.push({
      n: next(),
      name: "within auto-approve threshold",
      status: "fail",
      detail: `above $${limits.requireApprovalAboveUsd}`,
    });
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `$${args.sizeUsd.toFixed(2)} is above the $${limits.requireApprovalAboveUsd} auto-approve threshold`,
      remainingUsd,
      checks,
    };
  }
  pass("within auto-approve threshold", `$${limits.requireApprovalAboveUsd} threshold`);

  const margin =
    venue === "futures" && (args.leverage ?? 1) > 1
      ? `, $${(args.sizeUsd / (args.leverage ?? 1)).toFixed(2)} margin at ${args.leverage}x`
      : "";

  if (closing) {
    return {
      decision: "ALLOW",
      reason: `closing trade, exempt from the daily cap${margin}`,
      remainingUsd,
      checks,
    };
  }

  return {
    decision: "ALLOW",
    reason: `within limits: $${remainingUsd.toFixed(2)} of today's $${limits.dailyTradeUsd} remaining${margin}`,
    remainingUsd,
    checks,
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
    // Closes gave exposure back rather than taking it, so they do not consume
    // the day's budget. Pre-futures rows carry no side and read as BUY, which
    // is what they all were.
    .filter(
      (a) =>
        !isClosing({
          venue: a.payload?.venue === "futures" ? "futures" : "spot",
          side: a.payload?.side === "SELL" ? "SELL" : "BUY",
          reduceOnly: a.payload?.reduceOnly === true,
        }),
    )
    .reduce((total, a) => {
      const size = Number(a.payload?.sizeUsd);
      return Number.isFinite(size) && size > 0 ? total + size : total;
    }, 0);
}
