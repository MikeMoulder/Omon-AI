/**
 * Omon's OAuth client metadata document.
 *
 *   GET /.well-known/oauth-client   (rewritten to here in next.config.ts)
 *
 * This URL *is* the client_id. Binance's authorization server advertises
 * `client_id_metadata_document_supported: true`, so instead of registering the
 * app in a developer portal and being handed an id, the app publishes a
 * document describing itself and the URL of that document is the id.
 *
 * Which means this route must stay publicly reachable on whatever host runs
 * Omon, or `scripts/mcp-auth.ts` cannot mint a token — the authorization server
 * fetches this before it will show a consent screen.
 */
import { NextResponse, type NextRequest } from "next/server";
import { oauthClientDocument } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Same origin rule as the x402 manifest: the request origin wins, and
  // PUBLIC_BASE_URL only overrides when a proxy makes the origin untrustworthy.
  // Getting this wrong publishes a client_id that does not match the one sent
  // to the authorize endpoint, and the flow fails with an opaque error.
  const baseUrl = process.env.PUBLIC_BASE_URL || request.nextUrl.origin;

  return NextResponse.json(oauthClientDocument(baseUrl), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
