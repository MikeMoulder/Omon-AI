/**
 * The console's feed. Server-Sent Events, one full snapshot per beat.
 *
 *   GET /api/stream
 *
 * Full snapshots rather than deltas, deliberately. The payload is a few KB, the
 * only consumer is one screen, and a delta protocol would introduce the one bug
 * class this cannot afford — a console that drifts out of sync with the server
 * during a recording and shows a number that was never true.
 *
 * SSE rather than polling because the moment a payment lands has to be visible
 * immediately, and because the edge is already configured for it: the Caddy
 * vhost omits `encode` and sets `flush_interval -1` precisely so gzip cannot
 * buffer this response. If the feed ever goes silent behind a proxy, that pair
 * of settings is the first thing to check.
 *
 * `x-accel-buffering: no` is the same instruction for nginx-shaped proxies,
 * which the request may still pass through somewhere upstream.
 */
import type { NextRequest } from "next/server";
import { consoleSnapshot } from "@/lib/console-state";

export const dynamic = "force-dynamic";

/** Matches the console's own sense of "live". Fast enough to see a payment land. */
const INTERVAL_MS = Number(process.env.CONSOLE_STREAM_MS ?? 2000);

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let timer: ReturnType<typeof setInterval> | undefined;

      const stop = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the client vanished mid-write.
        }
      };

      const send = async () => {
        if (closed) return;
        try {
          const snapshot = await consoleSnapshot();
          // Enqueueing after the client disconnects throws; the abort listener
          // usually wins the race, but not always.
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch (err) {
          console.warn("[stream] snapshot failed:", err);
          stop();
        }
      };

      // Immediately, so the screen is populated on first paint rather than
      // showing an empty console for one interval.
      await send();

      timer = setInterval(() => void send(), INTERVAL_MS);
      request.signal.addEventListener("abort", stop);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
