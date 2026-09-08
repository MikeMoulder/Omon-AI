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
 * **1. Closing is never blocked by a size or spending limit.** The daily cap,
 * the per-trade cap and the approval threshold all count trades that INCREASE
 * exposure and all exempt the ones that reduce it. This is a safety property,
 * not a loophole: a limit that also throttles exits can leave the agent holding
 * a position it is forbidden to close, which is a strictly more dangerous state
 * than the one the limit was protecting against. An agent must always be able to
 * get out.
 *
 * The per-trade exemption was added when the exit rules landed and found a real
 * instance: a $25 cap with a $1000 daily allowance had let a spot position
 * accumulate to $198 over several beats, and the stop-loss that wanted to close
 * it was refused for exceeding the per-trade cap. Nothing goes unbounded — a
 * spot sell is capped at what is held, and a futures close is reduceOnly.
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
  /**
   * Oldest mark that may still be used to size a trade.
   *
   * A price is an input to the size, not decoration. Size a $25 order off a
   * two-minute-old mark on a fast tape and the notional that reaches Binance is
   * not the notional the gate approved, which quietly voids the per-trade cap.
   */
  maxQuoteAgeMs: number;
  /**
   * Booked loss over the trailing 24h that stops the agent opening anything new.
   *
   * A positive number describing a negative outcome: 50 means "halt once the day
   * is $50 down". The per-trade and daily caps bound how much can be *committed*;
   * neither notices that every one of those trades lost.
   */
  dailyLossHaltUsd: number;
  /**
   * Distance below the high-water mark that stops the agent opening anything new.
   *
   * The daily loss halt resets with the window. This one does not, so an agent
   * losing steadily over three days is caught by this and not by that.
   */
  maxDrawdownUsd: number;
};

const DEFAULTS: BudgetLimits = {
  maxTradeUsd: 25,
  dailyTradeUsd: 100,
  allowedSymbols: ["BNBUSDT", "BTCUSDT", "ETHUSDT"],
  requireApprovalAboveUsd: 25,
  maxLeverage: 3,
  maxQuoteAgeMs: 30_000,
  dailyLossHaltUsd: 50,
  maxDrawdownUsd: 75,
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
    maxQuoteAgeMs: num(process.env.BUDGET_MAX_QUOTE_AGE_MS, DEFAULTS.maxQuoteAgeMs),
    dailyLossHaltUsd: num(process.env.BUDGET_DAILY_LOSS_HALT_USD, DEFAULTS.dailyLossHaltUsd),
    maxDrawdownUsd: num(process.env.BUDGET_MAX_DRAWDOWN_USD, DEFAULTS.maxDrawdownUsd),
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
  /**
   * How old, in milliseconds, the mark used to size this trade is.
   *
   * Undefined means the caller did not measure it, and the check is skipped
   * rather than assumed fresh — a gate that invents a value it was not given is
   * worse than one that says it did not look.
   */
  quoteAgeMs?: number;
  /**
   * Booked profit over the trailing 24h, from `realizedPnlWindowUsd()`.
   * Negative means the day has cost money. Undefined skips the halt.
   */
  realizedPnl24hUsd?: number;
  /**
   * Dollars below the high-water mark, from `drawdownUsd()`. Never negative.
   * Undefined skips the halt.
   */
  drawdownUsd?: number;
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

  // Freshness before anything about size, because a stale mark makes every
  // later size check meaningless: they would all be comparing the right numbers
  // against the wrong price.
  if (args.quoteAgeMs !== undefined) {
    if (!Number.isFinite(args.quoteAgeMs) || args.quoteAgeMs < 0) {
      return block("quote is fresh", `quote age ${String(args.quoteAgeMs)} is not a valid duration`);
    }
    if (args.quoteAgeMs > limits.maxQuoteAgeMs) {
      return block(
        "quote is fresh",
        `the mark is ${(args.quoteAgeMs / 1000).toFixed(1)}s old, past the ` +
          `${(limits.maxQuoteAgeMs / 1000).toFixed(0)}s limit`,
      );
    }
    pass("quote is fresh", `${(args.quoteAgeMs / 1000).toFixed(1)}s old`);
  } else {
    skip("quote is fresh", "caller did not measure the mark's age");
  }

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

  // Closes are exempt from the per-trade cap, for the same reason they are
  // exempt from the daily one — and this is not hypothetical. A $25 cap with a
  // $1000 daily allowance lets a position accumulate to $198 across eight beats,
  // and a cap that also applies to selling then forbids the agent from ever
  // closing it. That is the exact state the exemption rule exists to prevent:
  // stranded in a position, holding the risk, not allowed to act.
  //
  // Nothing is unbounded by this. A spot sell is already capped at what the
  // ledger says is held (check 6) and a futures close is reduceOnly, so the
  // position itself is the ceiling.
  if (!closing && args.sizeUsd > limits.maxTradeUsd) {
    return block(
      "size within per-trade cap",
      `$${args.sizeUsd.toFixed(2)} exceeds the $${limits.maxTradeUsd} per-trade cap`,
    );
  }
  if (closing) {
    skip("size within per-trade cap", "closes are bounded by the position, not the cap");
  } else {
    pass("size within per-trade cap", `$${limits.maxTradeUsd} cap`);
  }

  // Both halts below stop the agent taking ON risk and never stop it shedding
  // risk. Same rule as the daily cap, for the same reason: an agent forbidden to
  // exit a losing position because it is losing is in a strictly worse state
  // than one that never traded. Every gate added here must exempt closes.

  if (args.realizedPnl24hUsd !== undefined && !closing) {
    if (!Number.isFinite(args.realizedPnl24hUsd)) {
      return block("daily loss halt", `realised P&L ${String(args.realizedPnl24hUsd)} is not a number`);
    }
    if (args.realizedPnl24hUsd <= -limits.dailyLossHaltUsd) {
      return block(
        "daily loss halt",
        `today is $${Math.abs(args.realizedPnl24hUsd).toFixed(2)} down, at or past the ` +
          `$${limits.dailyLossHaltUsd} halt. No new risk until the window rolls`,
      );
    }
    pass(
      "daily loss halt",
      `today ${args.realizedPnl24hUsd >= 0 ? "+" : "-"}$${Math.abs(args.realizedPnl24hUsd).toFixed(2)} ` +
        `of $${limits.dailyLossHaltUsd}`,
    );
  } else {
    skip("daily loss halt", closing ? "closes are exempt" : "caller did not measure the day");
  }

  if (args.drawdownUsd !== undefined && !closing) {
    if (!Number.isFinite(args.drawdownUsd) || args.drawdownUsd < 0) {
      return block("drawdown within limit", `drawdown ${String(args.drawdownUsd)} is not a valid distance`);
    }
    if (args.drawdownUsd >= limits.maxDrawdownUsd) {
      return block(
        "drawdown within limit",
        `$${args.drawdownUsd.toFixed(2)} below the high-water mark, at or past the ` +
          `$${limits.maxDrawdownUsd} limit. No new risk until it recovers`,
      );
    }
    pass("drawdown within limit", `$${args.drawdownUsd.toFixed(2)} of $${limits.maxDrawdownUsd}`);
  } else {
    skip("drawdown within limit", closing ? "closes are exempt" : "caller did not measure the peak");
  }

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

  // Same exemption, same reason. Parking an exit in REQUIRE_APPROVAL leaves the
  // agent holding the risk until a human wakes up, which is the failure this
  // whole rule exists to avoid. A human gates opening, never closing.
  if (!closing && args.sizeUsd > limits.requireApprovalAboveUsd) {
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
  if (closing) {
    skip("within auto-approve threshold", "an exit never waits for a human");
  } else {
    pass("within auto-approve threshold", `$${limits.requireApprovalAboveUsd} threshold`);
  }

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
