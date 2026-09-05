/**
 * Mints a Binance MCP access token:
 *
 *   npx tsx scripts/mcp-auth.ts
 *
 * WHY THIS EXISTS. Binance MCP is OAuth-only and there is no machine path to a
 * token. Probed 2026-09-05 against agent.binance.com:
 *
 *   - `X-MBX-APIKEY` (an exchange key) returns 401. Exchange keys are not
 *     MCP credentials.
 *   - `/.well-known/oauth-authorization-server` advertises
 *     `grant_types_supported: ["authorization_code"]` and nothing else, so
 *     there is no `client_credentials` flow a server could use unattended.
 *   - `token_endpoint_auth_methods_supported: ["none"]` — a public client, so
 *     no client secret is needed.
 *   - `client_id_metadata_document_supported: true` — the client_id is simply a
 *     URL serving a small JSON document, so there is no developer-portal
 *     registration either. `/register` returns 404 precisely because none is
 *     needed.
 *
 * So: a human authorises once in a browser, and the resulting bearer token
 * works from any server afterwards, Vercel included. That is the whole reason
 * the app can use MCP in production at all.
 *
 * There is no `refresh_token` grant advertised, so treat the token as expiring
 * with no automatic renewal. Every caller in `src/lib/exchange.ts` falls back
 * to REST and records why, so an expired token degrades the demo instead of
 * breaking it — but re-run this before recording.
 */
import crypto from "node:crypto";
import http from "node:http";

import dotenv from "dotenv";
// Next reads .env.local automatically; a plain node script does not — and
// PUBLIC_BASE_URL lives there, so without this the mint refuses to start with
// "PUBLIC_BASE_URL is not set" even on a fully configured box.
dotenv.config({ path: [".env.local", ".env"], quiet: true });

import { writeTokenFile } from "@/lib/mcp";

const AS = "https://agent.binance.com";
const PORT = Number(process.env.MCP_AUTH_PORT ?? 8788);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

/**
 * Our client_id — a URL, not an opaque string.
 *
 * Binance advertises `client_id_metadata_document_supported: true`, so it
 * FETCHES this URL during the authorize step to learn about the client. It must
 * therefore be reachable from Binance's servers: the public origin Omon runs
 * on, serving `/.well-known/oauth-client`.
 *
 * Set PUBLIC_BASE_URL (or MCP_OAUTH_CLIENT_ID) to that origin before running
 * this. A loopback client_id is checked for below and refused, because the
 * failure it produces otherwise is an opaque error on Binance's page with
 * nothing in any local log to explain it.
 */
const CLIENT_ID =
  process.env.MCP_OAUTH_CLIENT_ID ??
  (process.env.PUBLIC_BASE_URL
    ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/.well-known/oauth-client`
    : "");

const b64url = (b: Buffer) => b.toString("base64url");

async function discover(): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const res = await fetch(`${AS}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  return (await res.json()) as { authorization_endpoint: string; token_endpoint: string };
}

/**
 * Catch the redirect. Loopback only — the browser is on this machine, so this
 * never needs to be reachable from outside, unlike the client_id document.
 */
function listenForCode(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      const error = url.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<h2>${error ? "Authorisation failed" : "Authorised"}</h2><p>${
          error ?? "You can close this tab and return to the terminal."
        }</p>`,
      );

      server.close();
      if (error || !code) reject(new Error(error ?? "no code in callback"));
      else resolve({ code, state });
    });

    server.on("error", reject);
    server.listen(PORT, "127.0.0.1");
  });
}

/**
 * Fail before opening a browser rather than after. Both of these produce
 * errors on Binance's page with nothing local to explain them, which is an
 * expensive way to learn about a missing environment variable.
 */
async function preflight(): Promise<void> {
  if (!CLIENT_ID) {
    console.error(
      "\nPUBLIC_BASE_URL is not set, so there is no client_id to send.\n\n" +
        "Binance fetches the client_id URL server-side during authorisation, so it must be\n" +
        "the public origin Omon runs on. On the VPS:\n\n" +
        "  PUBLIC_BASE_URL=https://your-omon-host npx tsx scripts/mcp-auth.ts\n",
    );
    process.exit(1);
  }

  if (/127\.0\.0\.1|localhost/.test(CLIENT_ID)) {
    console.error(
      `\nclient_id is a loopback URL (${CLIENT_ID}) and Binance cannot fetch it.\n` +
        "Point PUBLIC_BASE_URL at the public origin serving /.well-known/oauth-client.\n",
    );
    process.exit(1);
  }

  // The document has to be live before the flow starts, not merely deployed.
  try {
    const res = await fetch(CLIENT_ID, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const doc = (await res.json()) as { redirect_uris?: string[] };
    if (!doc.redirect_uris?.includes(REDIRECT_URI)) {
      console.error(
        `\n${CLIENT_ID} does not list ${REDIRECT_URI} in redirect_uris.\n` +
          "Set MCP_AUTH_PORT to match the port in the published document, or vice versa.\n",
      );
      process.exit(1);
    }
    console.log(`client_id document reachable: ${CLIENT_ID}`);
  } catch (err) {
    console.error(`\nCould not fetch the client_id document at ${CLIENT_ID}: ${err}`);
    console.error("It must be publicly reachable before this flow can start.\n");
    process.exit(1);
  }
}

async function main() {
  await preflight();
  const meta = await discover();

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  console.log("\nOpen this URL in a browser and approve:\n");
  console.log(authUrl.toString());
  console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...\n`);

  const { code, state: returned } = await listenForCode();
  if (returned !== state) throw new Error("state mismatch — possible interference, aborting");

  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  } | null;

  if (!res.ok || !body?.access_token) {
    console.error(`\ntoken exchange failed: ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  // Written to a file, not printed for pasting. The file is what lets the
  // long-running VPS process renew itself later without anyone opening a
  // browser again — an env var cannot be rewritten from inside the process.
  writeTokenFile({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
  });

  console.log("\n--- token minted ---");
  // MEASURE THE LIFETIME. handoff.md flagged this as unknown, and on a VPS it
  // is the number that decides whether the agent survives unattended overnight.
  console.log(
    `expires_in:    ${
      body.expires_in
        ? `${body.expires_in}s (~${Math.round(body.expires_in / 3600)}h)`
        : "not stated by the server"
    }`,
  );
  console.log(
    `refresh_token: ${
      body.refresh_token
        ? "ISSUED — the process can renew itself unattended"
        : "NOT issued — this browser step must be repeated when the token expires"
    }`,
  );
  console.log(`\nSaved to ${process.env.BINANCE_MCP_TOKEN_FILE ?? ".mcp-token.json"} (mode 600).`);
  console.log("Never commit it — it authorises the real Binance account.\n");
  console.log("Verify with:  npx tsx scripts/mcp-smoke.ts\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
