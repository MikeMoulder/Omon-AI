/**
 * Runs once when a server instance starts, before it handles any request.
 *
 * This is Omon's heartbeat: without it nothing happens unless a human presses a
 * button, and an autonomous agent that needs poking is a demo, not an agent.
 *
 * IT DRIVES THE TICK OVER HTTP, ON PURPOSE. This file is bundled into a
 * DIFFERENT MODULE GRAPH from the route handlers, so anything it imported from
 * `@/lib` would be a separate instance with its own ledger and its own budget
 * arithmetic — which was observed placing real orders that no route could see,
 * against a daily cap that was consequently enforced twice. Calling the route
 * keeps every piece of state in the one graph that serves requests, and makes
 * this timer behave identically to an external cron.
 *
 * So: no `@/lib` imports here, and no application state. A timer and a fetch.
 */

/** Matches src/lib/scheduler.ts. Read from env in both graphs, so they agree. */
const INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 5 * 60_000);

/**
 * Delay before the first beat. The server has to be listening before a beat can
 * call it, and a cold start is exactly when someone is loading the console.
 */
const FIRST_BEAT_MS = Number(process.env.TICK_FIRST_BEAT_MS ?? 8_000);

/**
 * Where to call itself.
 *
 * Loopback, never PUBLIC_BASE_URL: a beat must not depend on DNS, the Caddy
 * vhost or a certificate, and it should keep working if the public name is
 * pointed elsewhere. `next start -p N` sets PORT (start-server.js), but it is
 * read lazily at fire time rather than at module load in case that ordering
 * ever changes. TICK_SELF_URL overrides it.
 */
function selfUrl(): string {
  const base = process.env.TICK_SELF_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  return `${base.replace(/\/$/, "")}/api/cron/tick`;
}

async function fire(): Promise<void> {
  try {
    const res = await fetch(selfUrl(), {
      method: "POST",
      // Lets the route label the beat "schedule" rather than "manual".
      headers: { "x-omon-heartbeat": "1" },
      // A beat is 15-40s; the tick route asks for 120s. Do not cut it short.
      signal: AbortSignal.timeout(150_000),
    });

    if (!res.ok) {
      console.error(`[heartbeat] tick returned http ${res.status}`);
      return;
    }

    const body = (await res.json()) as {
      tookMs?: number;
      skipped?: string | null;
      order?: { side: string; symbol: string; status: string } | null;
      decision?: { decision: string } | null;
    };

    const what = body.order
      ? `${body.order.side} ${body.order.symbol} ${body.order.status}`
      : (body.decision?.decision ?? body.skipped ?? "no verdict");
    console.log(`[heartbeat] beat in ${body.tookMs}ms — ${what}`);
  } catch (err) {
    // The interval must outlive any single failure — a bad news hour, a model
    // outage, or the server not being ready for the very first beat.
    console.error("[heartbeat] beat failed:", err instanceof Error ? err.message : err);
  }
}

export function register(): void {
  // Next calls register() in every runtime. The tick places orders and spawns
  // the Skill Hub CLI; neither exists on the edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.TICK_AUTOSTART === "0") {
    console.log("[heartbeat] disabled by TICK_AUTOSTART=0");
    return;
  }

  setTimeout(() => {
    void fire();
    // Created only after the first beat is under way, so a slow cold start
    // cannot stack a queue of beats behind it.
    setInterval(() => void fire(), INTERVAL_MS).unref?.();
  }, FIRST_BEAT_MS).unref?.();

  console.log(
    `[heartbeat] armed — first beat in ${Math.round(FIRST_BEAT_MS / 1000)}s, ` +
      `then every ${Math.round(INTERVAL_MS / 1000)}s`,
  );
}
