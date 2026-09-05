/**
 * The service catalogue. Free, public, and never behind a 402 — a buyer cannot
 * pay for something it has not been able to read about first.
 *
 * This is Omon's answer to not being listed anywhere: hand an agent the base URL
 * and this document tells it everything a directory entry would have, including
 * which chain settles and that the chain is a testnet.
 *
 * Also served at /.well-known/x402 via a rewrite in next.config.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { serviceManifest } from "@/lib/service";
import { mcpMode } from "@/lib/mcp";
import { cliMode } from "@/lib/skillhub";
import { network, payTo, price, rail } from "@/lib/x402";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // The request origin wins. An earlier version preferred RESOURCE_SERVER_URL,
  // which is the *buyer* script's variable — it pinned every published URL to
  // localhost:3000 no matter which port or domain was actually serving. Only an
  // explicit PUBLIC_BASE_URL overrides, for the case where a proxy rewrites the
  // host and the origin genuinely cannot be trusted.
  const baseUrl = process.env.PUBLIC_BASE_URL || request.nextUrl.origin;

  // The Agent OS block reports the live connection state rather than a static
  // boast: if the MCP token has expired, the catalogue says "not connected" and
  // why. A manifest that claims an integration it no longer has is worse than
  // one that admits the gap.
  return NextResponse.json(
    serviceManifest({ baseUrl, price, network, payTo, rail, mcp: mcpMode(), cli: cliMode() }),
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
