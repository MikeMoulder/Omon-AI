/**
 * The console's primitives. Every surface, number and label on the page comes
 * from here, which is the point: the old screen set its own type size and its
 * own border in forty places and drifted into six different greys and text as
 * small as 9px. One place to change means one look.
 *
 * Four type sizes exist on this page and no others:
 *   text-xs   labels and secondary detail
 *   text-sm   body
 *   text-lg   section headings and position figures
 *   text-5xl  the one hero number
 *
 * Weight and colour carry hierarchy. Reaching for a fifth size is the tell that
 * something belongs in a different component.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GateCheck } from "@/lib/types";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToMotion(onChange: () => void): () => void {
  const query = window.matchMedia(MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * True when the viewer asked for less motion. Every animation here honours it.
 *
 * `useSyncExternalStore` rather than an effect that calls setState: matchMedia
 * is an external store, and reading it into state inside an effect body causes
 * a second render on every mount for a value that never changes. The server
 * snapshot is `false` because there is no media query to read there, and the
 * client corrects it on hydration before anything animates.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia(MOTION_QUERY).matches,
    () => false,
  );
}

/**
 * A number that tweens to its new value instead of snapping.
 *
 * The one delight moment on the page, and it is spent on the P&L headline
 * because that is the number the whole product is about. Everything else
 * updates instantly. Two of these on a screen would be a toy.
 *
 * Tabular figures throughout, so the digits do not jitter the layout while the
 * count runs.
 */
export function AnimatedNumber({
  value,
  decimals = 2,
  prefix = "",
  className = "",
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    // Reduced motion renders `value` directly below, so there is nothing to
    // tween and nothing to set. The ref still tracks it, so turning motion back
    // on animates from where the number actually is rather than jumping.
    if (reduced) {
      from.current = value;
      return;
    }

    const start = performance.now();
    const a = from.current;
    const b = value;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(a + (b - a) * eased);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else from.current = b;
    };

    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, reduced]);

  const shown = reduced ? value : display;
  const sign = shown > 0.005 ? "+" : shown < -0.005 ? "-" : "";

  return (
    <span className={`num ${className}`}>
      {sign}
      {prefix}
      {Math.abs(shown).toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  );
}

/**
 * Green above zero, red below, neutral at flat.
 *
 * The only place these two colours are allowed on the page. If something is
 * green here it made money, and a viewer can rely on that without being told.
 */
export function moneyTone(n: number | null | undefined): string {
  if (n === null || n === undefined) return "text-muted";
  if (n > 0.005) return "text-up";
  if (n < -0.005) return "text-down";
  return "text-ink2";
}

/** Money with its sign kept. On a P&L the sign IS the information. */
export function signedUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "not priced";
  if (Math.abs(n) < 0.005) return "$0.00";
  return `${n > 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function signedPct(fraction: number | null): string {
  if (fraction === null) return "";
  const pct = fraction * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "-" : ""}${Math.abs(pct).toFixed(2)}%`;
}

/** Spans BTC at 0.00011 and BNB at 0.026, so significant digits suit both. */
export function qty(n: number): string {
  return Math.abs(n).toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

export function mark(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });
}

export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * Strip em dashes out of anything the screen is about to show.
 *
 * Not a style preference, a correctness one: most of the text on this page is
 * written by a language model or lifted off an RSS feed, and both produce em
 * dashes constantly. Fixing the strings in this codebase only fixes the
 * strings in this codebase. A thesis, a headline or a summary generated ten
 * seconds ago is beyond the reach of any grep, and so is every row already
 * written to `data/*.jsonl` before the rule existed.
 *
 * So the guarantee is made where the text meets the DOM, which is the one place
 * it can actually be kept. Apply it to every model or feed derived string.
 *
 * Em dash only. En dashes are left alone because they carry ranges, and
 * "5 to 10" turning into "5, 10" would change a number's meaning.
 */
export function plain(text: string): string {
  return text.replace(/\s*—\s*/g, ", ");
}

export function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * A live indicator with an expanding ring behind it.
 *
 * The ring is the cheapest possible signal that the page is receiving data
 * rather than showing a screenshot, and during a recording that distinction is
 * the whole credibility of the demo.
 */
export function StatusDot({ tone = "up", pulse = true }: { tone?: "up" | "warn" | "down" | "muted"; pulse?: boolean }) {
  const color =
    tone === "up"
      ? "var(--up)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "down"
          ? "var(--down)"
          : "var(--faint)";

  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
      {pulse ? (
        <span
          className="absolute inline-flex h-full w-full rounded-full"
          style={{ background: color, animation: "omon-ring 2s ease-out infinite" }}
        />
      ) : null}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

const TONES: Record<string, string> = {
  neutral: "border-edge2 bg-elev text-muted",
  brand: "border-brand/30 bg-brand/10 text-brand",
  up: "border-up/30 bg-up/10 text-up",
  down: "border-down/30 bg-down/10 text-down",
  warn: "border-warn/30 bg-warn/10 text-warn",
};

export function Pill({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: keyof typeof TONES | string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${
        TONES[tone] ?? TONES.neutral
      }`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div className={`card sheen ${hover ? "card-hover" : ""} ${className}`}>{children}</div>
  );
}

/**
 * One figure with a label above it and a sentence under it.
 *
 * The sentence is not optional and it is not decoration. The first version of
 * this console showed "Traded · 24h  $59.11" and the most common reaction was
 * asking what that meant. A number with no sentence is a number nobody trusts.
 */
export function Stat({
  label,
  value,
  sub,
  tone,
  delay = 0,
}: {
  label: string;
  value: ReactNode;
  sub: string;
  tone?: string;
  delay?: number;
}) {
  return (
    <Card hover className="rise px-4 py-3.5" >
      <div style={{ animationDelay: `${delay}ms` }}>
        <p className="eyebrow">{label}</p>
        <p className={`mt-2 text-lg font-semibold leading-none ${tone ?? "text-ink"}`}>{value}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">{sub}</p>
      </div>
    </Card>
  );
}

/**
 * An empty state, which is the state a judge is most likely to hit by accident.
 *
 * Always says what goes here and what would put it there, never just "no data".
 */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="h-8 w-8 rounded-full border border-edge2 bg-elev" aria-hidden />
      <p className="max-w-sm text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

/** Loading, in the shape of the content that is coming. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel h-16 w-full" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}

/** A capped bar. Used for the daily budget, where the cap is the point. */
export function Bar({ used, total, tone = "brand" }: { used: number; total: number; tone?: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  const color = tone === "brand" ? "var(--brand)" : tone === "down" ? "var(--down)" : "var(--up)";
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-elev">
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

/**
 * A list that scrolls inside itself instead of growing the page.
 *
 * This is the fix for the old console's worst layout habit: every panel was a
 * plain list, so a busy hour pushed the footer off the bottom of the screen and
 * the P&L along with it. The pane is a fixed viewport onto the feed now, and
 * rows enter at the top rather than extending it.
 */
export function ScrollList({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
      <ul className="space-y-2.5">{children}</ul>
    </div>
  );
}

/** One row in a ScrollList. Staggered entrance, capped by the caller at 8. */
export function Row({
  children,
  index = 0,
  fresh = false,
  tone = "neutral",
}: {
  children: ReactNode;
  index?: number;
  fresh?: boolean;
  tone?: "neutral" | "down" | "up";
}) {
  const border =
    tone === "down"
      ? "border-down/25 bg-down/[0.04]"
      : tone === "up"
        ? "border-up/25 bg-up/[0.04]"
        : "border-edge bg-panel2";

  return (
    <li
      className={`rise rounded-[10px] border p-3 ${border} ${fresh ? "flash" : ""}`}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      {children}
    </li>
  );
}

/**
 * The budget gate's check trace, as a strip of numbered squares.
 *
 * Thirteen checks run on every trade and until now the console showed only the
 * sentence from whichever one refused. That sentence is the important part, but
 * on its own it reads as a single opinion rather than a sequence — and "the
 * spending limits said no" is exactly the claim a judge has no reason to
 * believe. The strip is the evidence: every check, in order, with the one that
 * stopped it marked.
 *
 * Skips are grey rather than green on purpose. A futures rule on a spot order
 * approved nothing, and colouring it as a pass would inflate what the gate did.
 */
export function GateTrace({ checks }: { checks: GateCheck[] }) {
  if (!checks || checks.length === 0) return null;

  const passed = checks.filter((c) => c.status === "pass").length;
  const skipped = checks.filter((c) => c.status === "skip").length;
  const failed = checks.find((c) => c.status === "fail");

  const tone = (status: GateCheck["status"]): string =>
    status === "pass"
      ? "bg-up/70"
      : status === "fail"
        ? "bg-down"
        : "bg-faint/30";

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-[3px]">
        {checks.map((c) => (
          <span
            key={c.n}
            // The native tooltip is deliberate: it needs no state, no portal and
            // no JS, and it survives being screen-recorded.
            title={`${c.n}. ${c.name}${c.detail ? ` — ${c.detail}` : ""}`}
            className={`h-[6px] w-[6px] rounded-[1px] ${tone(c.status)}`}
          />
        ))}
        <span className="num ml-1.5 text-[10px] text-faint">
          {checks.length} checks
          {passed > 0 ? `, ${passed} passed` : ""}
          {skipped > 0 ? `, ${skipped} skipped` : ""}
        </span>
      </div>
      {failed ? (
        <p className="num mt-1 text-[10px] text-down">
          check {failed.n} of {checks.length} refused: {failed.name}
        </p>
      ) : null}
    </div>
  );
}
