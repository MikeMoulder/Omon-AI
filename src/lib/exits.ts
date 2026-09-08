/**
 * When to close. Plain code, no model, no network.
 *
 * The gap this fills is not a refinement — it is the reason the console looked
 * wrong. Nothing in this codebase ever proposed an exit. A position opened and
 * then sat there until the Signal Agent happened, independently, to form an
 * opposing view on that same symbol. That is not a strategy with a hold period,
 * it is a strategy that forgets.
 *
 * ## Why the model is not asked
 *
 * The Intel and Signal agents decide what to buy. Whether to *keep* it is
 * arithmetic on a position that already exists, and arithmetic is exactly what a
 * language model is worst at and what plain code is perfect at. The same
 * reasoning that keeps `src/lib/budget.ts` model-free applies here, and more
 * strongly: an exit is the half of a trade that limits damage, and it must work
 * on the beat where the model is rate-limited, hallucinating, or down.
 *
 * ## The three rules
 *
 * | Rule | Default | Why |
 * |---|---|---|
 * | Take-profit | +2.5% | Momentum from a headline decays. Bank it. |
 * | Stop-loss | -1.5% | Tighter than the take-profit on purpose: the thesis is
 *   news-driven momentum, so a position going the wrong way is evidence the read
 *   was wrong, while one going the right way is only evidence it was right *so
 *   far*. Losers should die faster than winners are cut. |
 * | Time-stop | 6h | A thesis derived from a six-hour-old headline is not a
 *   thesis. The news has been priced, and holding past that is a directional bet
 *   nobody took deliberately. |
 *
 * ## Percentages are measured against notional on both venues
 *
 * Not return-on-margin. At 3x leverage those differ by a factor of three, so a
 * take-profit read off return-on-margin would fire on a 0.83% move in the asset
 * while the spot rule waited for 2.5%. One number has to mean one thing across
 * both venues — the same rule `src/lib/budget.ts` already applies to `sizeUsd`.
 */
import type { Position, PerpPosition } from "@/lib/pnl";
import type { Venue } from "@/lib/types";

export type ExitRule = "stop-loss" | "take-profit" | "time-stop";

export type ExitProposal = {
  symbol: string;
  venue: Venue;
  /** The side that CLOSES this position, not the side that opened it. */
  side: "BUY" | "SELL";
  /** Notional to close. The whole position — these rules do not scale out. */
  sizeUsd: number;
  rule: ExitRule;
  /** A sentence for the ledger and the console. */
  reason: string;
  unrealizedPct: number | null;
  heldMs: number;
  /** Futures closes must tell the exchange, so an overshoot shrinks not flips. */
  reduceOnly: boolean;
};

export type ExitLimits = {
  /** Close a winner at or above this, in percent. */
  takeProfitPct: number;
  /** Close a loser at or below the negative of this, in percent. */
  stopLossPct: number;
  /** Close anything held longer than this, in milliseconds. */
  maxHoldMs: number;
};

const DEFAULTS: ExitLimits = {
  takeProfitPct: 2.5,
  stopLossPct: 1.5,
  maxHoldMs: 6 * 60 * 60 * 1000,
};

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read per call, so a limit can change without a redeploy. */
export function exitLimitsFromEnv(): ExitLimits {
  return {
    takeProfitPct: num(process.env.EXIT_TAKE_PROFIT_PCT, DEFAULTS.takeProfitPct),
    stopLossPct: num(process.env.EXIT_STOP_LOSS_PCT, DEFAULTS.stopLossPct),
    maxHoldMs: num(process.env.EXIT_MAX_HOLD_MS, DEFAULTS.maxHoldMs),
  };
}

/** Percent as a signed number, or null when the position has no mark. */
function pctOf(p: { unrealizedPct: number | null }): number | null {
  return p.unrealizedPct === null || !Number.isFinite(p.unrealizedPct)
    ? null
    : p.unrealizedPct * 100;
}

function heldMsOf(lastFillAt: string, now: number): number {
  const t = new Date(lastFillAt).getTime();
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/**
 * Which rule, if any, this position has tripped.
 *
 * Stop-loss is tested first. It and take-profit are mutually exclusive by sign
 * so the order between them cannot matter, but stating it removes the question.
 * The time-stop runs last because it is the weakest reason of the three: it says
 * only that nothing happened, and if something *did* happen the ledger should
 * record that instead.
 */
function ruleFor(
  pct: number | null,
  heldMs: number,
  limits: ExitLimits,
): { rule: ExitRule; reason: string } | null {
  if (pct !== null && pct <= -limits.stopLossPct) {
    return {
      rule: "stop-loss",
      reason: `down ${Math.abs(pct).toFixed(2)}%, at or past the ${limits.stopLossPct}% stop`,
    };
  }

  if (pct !== null && pct >= limits.takeProfitPct) {
    return {
      rule: "take-profit",
      reason: `up ${pct.toFixed(2)}%, at or past the ${limits.takeProfitPct}% target`,
    };
  }

  if (heldMs >= limits.maxHoldMs) {
    const hours = (heldMs / 3_600_000).toFixed(1);
    const cap = (limits.maxHoldMs / 3_600_000).toFixed(1);
    return {
      rule: "time-stop",
      reason: `held ${hours}h, past the ${cap}h limit, and the headline behind it is stale`,
    };
  }

  return null;
}

/**
 * Every open position that should be closed now, most urgent first.
 *
 * Pure: no clock of its own, no network, no ledger read. `now` is passed in so
 * the whole thing is testable against fixtures, which is the only way a rule
 * that decides when to sell should ever be verified.
 *
 * An unpriced position is skipped rather than guessed at. A stop-loss computed
 * from a missing mark is not a safety feature, it is a random sell.
 */
export function exitsFor(args: {
  spot: Position[];
  futures: PerpPosition[];
  now: number;
  limits?: ExitLimits;
}): ExitProposal[] {
  const limits = args.limits ?? exitLimitsFromEnv();
  const out: ExitProposal[] = [];

  for (const p of args.spot) {
    // Flat rows survive in the P&L fold because they still carry realised
    // profit. There is nothing to close.
    if (p.qty <= 0) continue;
    if (p.markPrice === null || p.marketValueUsd === null) continue;

    const pct = pctOf(p);
    const heldMs = heldMsOf(p.lastFillAt, args.now);
    const hit = ruleFor(pct, heldMs, limits);
    if (!hit) continue;

    out.push({
      symbol: p.symbol,
      venue: "spot",
      // Spot cannot short, so closing a holding is always a sell.
      side: "SELL",
      sizeUsd: p.marketValueUsd,
      rule: hit.rule,
      reason: hit.reason,
      unrealizedPct: pct,
      heldMs,
      reduceOnly: false,
    });
  }

  for (const p of args.futures) {
    if (p.qty === 0 || p.direction === "flat") continue;
    if (p.markPrice === null) continue;

    const pct = pctOf(p);
    const heldMs = heldMsOf(p.lastFillAt, args.now);
    const hit = ruleFor(pct, heldMs, limits);
    if (!hit) continue;

    out.push({
      symbol: p.symbol,
      venue: "futures",
      // A long is closed by selling and a short by buying. Derived from the
      // position's own sign, never from anything a model said.
      side: p.qty > 0 ? "SELL" : "BUY",
      // Sized on the LIVE mark, never on `notionalUsd`.
      //
      // `notionalUsd` is |qty| * ENTRY. The order path turns a dollar figure back
      // into a quantity by dividing by the CURRENT mark and flooring to the
      // symbol's step, so entry dollars buy fewer units whenever price has moved
      // against the position — which is exactly when a stop fires. A 0.02 BNB
      // short entered at 739.57 and stopped at 752.71 asked for $14.79, which is
      // 0.0196 at the mark, which floors to 0.01 on a 0.01 step. Half the
      // position stayed open on a stop-loss, and the ledger called it closed.
      //
      // Sizing at the mark makes the division exact. The 0.1% nudge covers
      // floating-point error in that round trip, where landing a hair low costs
      // a whole step. Over-asking is safe here and under-asking is not: every
      // one of these is reduceOnly, so the exchange caps the fill at the
      // position and cannot flip it. Spot needs no nudge and gets none — it is
      // sized from marketValueUsd, already the live mark, and an over-sized spot
      // sell would bounce with -2010.
      sizeUsd: Math.abs(p.qty) * p.markPrice * 1.001,
      rule: hit.rule,
      reason: hit.reason,
      unrealizedPct: pct,
      heldMs,
      reduceOnly: true,
    });
  }

  // Stops before targets before time. A beat closes one position, so when two
  // rules fire at once the one that is losing money goes first.
  const rank: Record<ExitRule, number> = { "stop-loss": 0, "take-profit": 1, "time-stop": 2 };
  return out.sort((a, b) => rank[a.rule] - rank[b.rule]);
}

/**
 * How far a position is from each of its exits, for the console.
 *
 * Separate from `exitsFor` on purpose: that function answers "close this?" and
 * must stay easy to verify. This one answers "how close is it?", which is a
 * display concern and should never be able to affect the decision.
 */
export function exitDistance(
  p: { unrealizedPct: number | null; lastFillAt: string },
  now: number,
  limits: ExitLimits = exitLimitsFromEnv(),
): { toTakeProfitPct: number | null; toStopLossPct: number | null; toTimeStopMs: number } {
  const pct = pctOf(p);
  return {
    toTakeProfitPct: pct === null ? null : limits.takeProfitPct - pct,
    toStopLossPct: pct === null ? null : pct + limits.stopLossPct,
    toTimeStopMs: Math.max(0, limits.maxHoldMs - heldMsOf(p.lastFillAt, now)),
  };
}
