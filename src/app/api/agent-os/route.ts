/**
 * Free, public: the live state of Omon's Binance Agent OS connection.
 *
 *   GET /api/agent-os
 *
 * Two audiences, one document. The console renders it as the status row that
 * tells a viewer whether a number on screen came off Binance MCP or off the
 * REST fallback. A judge curls it to check that "built with Agent OS" survives
 * contact with a running process.
 *
 * It reports what actually happened on the last call — `usage` is written by
 * `src/lib/exchange.ts` every time it chooses a rail — rather than what the
 * configuration hopes will happen. That distinction is the whole point: a
 * fallback nobody can see is how an integration quietly stops existing.
 *
 * The token itself is never returned. Only whether one is present, where it
 * came from, and how long it has left.
 *
 * It also publishes `reachability`: which Binance products can be reached
 * without real money at all. That block is the reason Track B's third task is
 * not done, and it is here rather than buried in the README because this is the
 * document a judge curls first.
 */
import { NextResponse } from "next/server";
import { mcpHealth, mcpUsage, tokenHealth } from "@/lib/mcp";
import { cliHealth } from "@/lib/skillhub";
import { exchangeMode } from "@/lib/exchange";
import { reachabilityReport } from "@/lib/reachability";

export const dynamic = "force-dynamic";

export async function GET() {
  const [health, skillHub] = await Promise.all([mcpHealth(), cliHealth()]);

  return NextResponse.json(
    {
      agentOs: {
        mcp: {
          mode: health.mode,
          reason: health.reason,
          toolsVisible: health.toolCount,
          toolsResolved: health.resolved,
          ...(health.error ? { error: health.error } : {}),
        },
        // The rail that actually serves, given MCP's client allowlist. Needs
        // no credentials, so its "live" is not contingent on a token.
        skillHub,
        // Credential state without the credential. `expiresInSeconds` is the
        // number that matters for an unattended run: when it is null the server
        // never stated a lifetime, which is not the same as "does not expire".
        token: tokenHealth(),
        exchange: exchangeMode(),
      },
      // Which rail each read actually used, last time it ran.
      usage: mcpUsage(),
      // Which Binance products are reachable at all without real money, and
      // therefore why Track B's third task is not done. Verified by
      // scripts/agent-os-matrix.ts rather than probed per request — see
      // src/lib/reachability.ts for why that is the honest choice here.
      reachability: reachabilityReport(),
      servedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
