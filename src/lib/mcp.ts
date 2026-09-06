/**
 * Binance MCP seam. The only file that speaks the Model Context Protocol.
 *
 * This is the Binance Agent OS surface. `exchange.ts` is the REST surface; both
 * are Agent OS, and they are deliberately not the same rail:
 *
 *   reads  (prices, candles, account state)  -> here, Binance MCP, real mainnet
 *   writes (orders)                          -> exchange.ts, Spot Demo Mode
 *
 * The reason is not preference. The MCP token authorises the operator's REAL
 * Binance account (`canTrade: true`). An order placed through this file would
 * spend real money, so this file has no write path at all and must not grow one.
 *
 * Transport is Streamable HTTP: JSON-RPC over POST, with the server free to
 * answer in `application/json` or as an SSE stream. Hand-rolled rather than
 * pulled from an SDK, for the same reason `exchange.ts` hand-rolls REST+HMAC —
 * one dependency fewer to bundle into a serverless function, and the wire
 * format is small enough to read.
 *
 * AUTH — verified 2026-09-05 against agent.binance.com:
 *   - Exchange API keys do NOT work here. `X-MBX-APIKEY` returns 401.
 *   - The OAuth server advertises `grant_types_supported: ["authorization_code"]`
 *     and nothing else, so there is no client_credentials flow and a server can
 *     never mint its own token. A human authorises once in a browser.
 *   - `scripts/mcp-auth.ts` runs that flow and prints the token to paste into
 *     BINANCE_MCP_ACCESS_TOKEN.
 *   - There is no refresh grant either, so assume the token expires and make
 *     sure every caller degrades instead of failing. That is what
 *     `exchange.ts` does with the results of this file.
 */

import fs from "node:fs";

const URL_ = process.env.BINANCE_MCP_URL ?? "https://agent.binance.com/mcp/agentic";
const TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS ?? 10_000);
const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "McpError";
  }
}

/* ────────────────────────── token store ────────────────────────── */

/**
 * Where the token lives.
 *
 * Omon runs as a long-lived process on a VPS, not as a serverless function, so
 * the token is read from a FILE first and the environment second. That ordering
 * matters: a file is writable, which is what makes unattended renewal possible.
 * A process that can rewrite its own credential can stay authenticated for days
 * without anyone opening a browser again; one holding a token in an env var
 * cannot, because env vars do not survive being changed from inside.
 *
 * The browser step from `scripts/mcp-auth.ts` therefore happens ONCE, not per
 * run and not per restart.
 */
const TOKEN_FILE = process.env.BINANCE_MCP_TOKEN_FILE ?? ".mcp-token.json";

export type StoredToken = {
  access_token: string;
  refresh_token?: string;
  /** ms epoch. Absent when the server did not state a lifetime. */
  expires_at?: number;
};

let cachedToken: StoredToken | null = null;
let cachedAt = 0;

/** Re-read the file this often, so a token minted in another shell is picked up. */
const TOKEN_RELOAD_MS = 30_000;

/**
 * Every read is wrapped: a missing, unreadable or malformed token file must
 * degrade to "no token" and let the caller fall back to REST, never throw from
 * module-adjacent code and take a route down with it.
 *
 * This seam is Node-only by design (`node:fs`), which is fine — Omon runs as a
 * long-lived Node process, and every route that touches it is server-rendered.
 */
function readTokenFile(): StoredToken | null {
  try {
    // turbopackIgnore: the path is a runtime value, and without this the
    // bundler traces the whole project trying to resolve it statically.
    if (!fs.existsSync(/*turbopackIgnore: true*/ TOKEN_FILE)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(/*turbopackIgnore: true*/ TOKEN_FILE, "utf8"),
    ) as StoredToken;
    return parsed.access_token ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTokenFile(token: StoredToken): void {
  // 0600: the token authorises a real Binance account, so it should not be
  // readable by other users on a shared VPS.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
  cachedToken = token;
  cachedAt = Date.now();
}

/**
 * The token in force right now: file first, environment second.
 *
 * Only the FILE read is cached — it is the hot path and it touches the disk on
 * every RPC otherwise. The environment is read fresh each time, because caching
 * it buys nothing (no syscall) and would make the seam report a token that is
 * no longer set.
 *
 * The cache window is also why a token minted in another shell takes effect on
 * a running process within `TOKEN_RELOAD_MS` rather than needing a restart.
 */
function currentToken(): StoredToken | null {
  if (cachedToken && Date.now() - cachedAt < TOKEN_RELOAD_MS) return cachedToken;

  const fromFile = readTokenFile();
  if (fromFile) {
    cachedToken = fromFile;
    cachedAt = Date.now();
    return fromFile;
  }

  cachedToken = null;
  cachedAt = Date.now();

  const fromEnv = process.env.BINANCE_MCP_ACCESS_TOKEN;
  return fromEnv ? { access_token: fromEnv } : null;
}

/** True when the stored token is past, or within a minute of, its stated expiry. */
function isExpiring(token: StoredToken): boolean {
  return token.expires_at !== undefined && Date.now() > token.expires_at - 60_000;
}

/**
 * Swap a refresh token for a new access token.
 *
 * The authorization server does NOT advertise `refresh_token` in
 * `grant_types_supported` (checked 2026-09-05), so this may simply be refused —
 * which is why it is attempted rather than relied on, and why failure returns
 * false instead of throwing. If Binance does issue refresh tokens in practice,
 * a VPS process renews itself indefinitely and the browser step never recurs.
 * If it does not, `tokenHealth()` reports the expiry so the operator re-runs
 * `scripts/mcp-auth.ts` before it bites during a demo.
 */
async function tryRefresh(): Promise<boolean> {
  const token = currentToken();
  if (!token?.refresh_token) return false;

  try {
    const meta = (await (
      await fetch(`${new URL(URL_).origin}/.well-known/oauth-authorization-server`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    ).json()) as { token_endpoint: string };

    const res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: process.env.MCP_OAUTH_CLIENT_ID ?? "",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return false;
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) return false;

    writeTokenFile({
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? token.refresh_token,
      expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    });
    console.info("[mcp] access token refreshed");
    return true;
  } catch (err) {
    console.warn("[mcp] token refresh failed:", err);
    return false;
  }
}

/**
 * What the console should say about the credential, without printing it.
 * `expiresInSeconds` is the number that decides whether an unattended VPS run
 * survives the night.
 */
export function tokenHealth(): {
  present: boolean;
  source: "file" | "env" | "none";
  canRefresh: boolean;
  expiresInSeconds: number | null;
} {
  const token = currentToken();
  return {
    present: Boolean(token),
    source: token ? (readTokenFile() ? "file" : "env") : "none",
    canRefresh: Boolean(token?.refresh_token),
    expiresInSeconds: token?.expires_at
      ? Math.max(0, Math.round((token.expires_at - Date.now()) / 1000))
      : null,
  };
}

/**
 * Which path an MCP call will take, and why. Same contract as `llmMode()` and
 * `exchangeMode()` so the console can render one honest status line per seam.
 */
export function mcpMode(): { mode: "live" | "off"; reason: string } {
  if (process.env.DEMO_MODE === "fixture" && process.env.MCP_IN_FIXTURE_MODE !== "1") {
    return { mode: "off", reason: "DEMO_MODE=fixture" };
  }
  const token = currentToken();
  if (!token) {
    return { mode: "off", reason: "no MCP token, run: npx tsx scripts/mcp-auth.ts" };
  }
  if (isExpiring(token) && !token.refresh_token) {
    return { mode: "off", reason: "MCP token expired and no refresh token, re-run scripts/mcp-auth.ts" };
  }
  return { mode: "live", reason: `binance mcp @ ${new URL(URL_).host}` };
}

export function mcpEnabled(): boolean {
  return mcpMode().mode === "live";
}

/* ────────────────────────────── wire ────────────────────────────── */

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

let sessionId: string | null = null;
let initialised = false;
let nextId = 1;

/**
 * One JSON-RPC round trip.
 *
 * The server may answer as plain JSON or as an SSE stream carrying the same
 * envelope in `data:` lines — the spec allows either for the same request, so
 * both are handled rather than assumed.
 */
async function rpc(
  method: string,
  params?: Record<string, unknown>,
  opts: { notification?: boolean; isRetry?: boolean } = {},
): Promise<unknown> {
  let stored = currentToken();
  if (!stored) throw new McpError("no MCP token, run: npx tsx scripts/mcp-auth.ts");

  // Renew before the request rather than after a failure, when the server told
  // us when it expires. Cheaper than a failed call, and on a long-running VPS
  // this is the path that keeps the process authenticated unattended.
  if (isExpiring(stored) && !opts.isRetry && (await tryRefresh())) {
    stored = currentToken() ?? stored;
  }
  const token = stored.access_token;

  const id = opts.notification ? undefined : nextId++;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  let res: Response;
  try {
    res = await fetch(URL_, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new McpError(
      err instanceof Error && err.name === "TimeoutError"
        ? `binance mcp did not answer within ${TIMEOUT_MS}ms`
        : `binance mcp unreachable: ${String(err)}`,
    );
  }

  // The session id only arrives on the initialize response. Keep it for every
  // later request or the server treats each call as a new, uninitialised client.
  const returnedSession = res.headers.get("mcp-session-id");
  if (returnedSession) sessionId = returnedSession;

  if (res.status === 401) {
    // The most likely failure on a long-running process: the token aged out.
    // The session dies with it, so both are dropped before anything is retried.
    sessionId = null;
    initialised = false;

    // One refresh attempt, once. `isRetry` stops a rejected refresh token from
    // looping a 401 into an infinite retry.
    if (!opts.isRetry && (await tryRefresh())) {
      if (method !== "initialize") await ensureInitialised();
      return rpc(method, params, { ...opts, isRetry: true });
    }

    throw new McpError(
      "binance mcp rejected the token (401). It has expired or been revoked, re-run: npx tsx scripts/mcp-auth.ts",
      401,
    );
  }

  if (!res.ok) {
    throw new McpError(`binance mcp returned ${res.status}`, res.status);
  }

  // Notifications get 202 with no body and expect no answer.
  if (opts.notification || res.status === 202) return undefined;

  const raw = await res.text();
  const envelope = parseEnvelope(raw, id);

  if (envelope?.error) {
    throw new McpError(`binance mcp: ${envelope.error.message}`, envelope.error.code);
  }
  return envelope?.result;
}

/**
 * Pull the JSON-RPC envelope out of either response shape.
 *
 * SSE bodies carry one JSON object per `data:` line and may include unrelated
 * frames (pings, server notifications), so the matching id is what is looked
 * for rather than "the first thing that parses".
 */
function parseEnvelope(raw: string, id: number | undefined): JsonRpcResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }

  let fallback: JsonRpcResponse | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue;
    }
    if (id !== undefined && parsed.id === id) return parsed;
    if (parsed.result !== undefined || parsed.error) fallback ??= parsed;
  }
  return fallback;
}

/** Handshake. Idempotent — every entry point calls it and only the first does work. */
async function ensureInitialised(): Promise<void> {
  if (initialised) return;

  await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "omon", version: "0.1.0" },
  });
  // Required by the spec before any other request. The server answers 202.
  await rpc("notifications/initialized", undefined, { notification: true });
  initialised = true;
}

/* ────────────────────────────── tools ────────────────────────────── */

export type McpTool = { name: string; description?: string };

let toolCache: { names: string[]; at: number } | null = null;
const TOOL_TTL_MS = 5 * 60_000;

/** Every tool the server exposes to this token. Cached — the list is stable. */
export async function mcpTools(): Promise<string[]> {
  if (toolCache && Date.now() - toolCache.at < TOOL_TTL_MS) return toolCache.names;

  await ensureInitialised();
  const result = (await rpc("tools/list")) as { tools?: McpTool[] } | undefined;
  const names = (result?.tools ?? []).map((t) => t.name);

  toolCache = { names, at: Date.now() };
  return names;
}

/**
 * Find whichever spelling of a tool this server actually publishes.
 *
 * The Binance server names the same operation two ways depending on how it is
 * reached — `spot_klines` when exposed directly, `spot.klines` through its
 * search/execute gateway. Rather than guessing and getting a confusing
 * "unknown tool" at demo time, the live list decides.
 */
export async function resolveTool(candidates: string[]): Promise<string | null> {
  const names = await mcpTools();
  for (const candidate of candidates) {
    if (names.includes(candidate)) return candidate;
  }
  // Last resort: match on the operation regardless of separator or namespace.
  const wanted = candidates.map((c) => c.replace(/[._]/g, "").toLowerCase());
  return names.find((n) => wanted.includes(n.replace(/[._]/g, "").toLowerCase())) ?? null;
}

/**
 * Call a tool and hand back its decoded payload.
 *
 * MCP wraps results as `content: [{type:"text", text}]`, where the text is
 * itself JSON for every Binance tool. Both layers are unwrapped here so callers
 * see the same shape the REST endpoint would have given them.
 */
export async function mcpCall(
  name: string | string[],
  args: Record<string, unknown> = {},
): Promise<unknown> {
  await ensureInitialised();

  const candidates = Array.isArray(name) ? name : [name];
  const resolved = await resolveTool(candidates);
  if (!resolved) {
    throw new McpError(`binance mcp does not expose any of: ${candidates.join(", ")}`);
  }

  const result = (await rpc("tools/call", { name: resolved, arguments: args })) as
    | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    | undefined;

  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";

  if (result?.isError) {
    throw new McpError(`binance mcp tool ${resolved} failed: ${text || "no detail"}`);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some tools answer with prose. Hand it back rather than throwing — the
    // caller knows whether it wanted JSON.
    return text;
  }
}

/* ─────────────────────── oauth client identity ─────────────────────── */

/**
 * The OAuth client metadata document — Omon's registration, served rather than
 * filed.
 *
 * Binance's authorization server advertises
 * `client_id_metadata_document_supported: true`, which means the `client_id` is
 * a URL and the server FETCHES it to learn about the client. That has one
 * consequence worth stating plainly: the client_id must be publicly reachable.
 * A `http://127.0.0.1` client_id cannot work, because Binance's servers cannot
 * open a socket to your laptop.
 *
 * This is why the document is served by the app itself at
 * `/.well-known/oauth-client` (rewritten from `/api/oauth-client` in
 * next.config.ts, same trick as the x402 manifest). Omon runs continuously on a
 * public host, so the app that wants the token is also the thing that publishes
 * its own identity — no developer-portal registration anywhere.
 *
 * `redirect_uris` lists the loopback callback too, so the one-time
 * `scripts/mcp-auth.ts` mint can complete in a browser on your own machine
 * while the client_id still resolves publicly.
 */
export function oauthClientDocument(baseUrl: string): Record<string, unknown> {
  const loopbackPort = process.env.MCP_AUTH_PORT ?? "8788";
  return {
    client_id: `${baseUrl}/.well-known/oauth-client`,
    client_name: "Omon",
    client_uri: baseUrl,
    redirect_uris: [
      `${baseUrl}/api/mcp/callback`,
      `http://127.0.0.1:${loopbackPort}/callback`,
    ],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    // Public client with PKCE. The server advertises
    // token_endpoint_auth_methods_supported: ["none"], so there is no secret.
    token_endpoint_auth_method: "none",
  };
}

/* ────────────────────────── observability ────────────────────────── */

/**
 * What actually happened on the MCP rail, per operation. The console reads this
 * so a viewer can tell a live Agent OS call from a REST fallback without
 * trusting a label.
 *
 * This exists because of the trap in handoff.md section 6: a silent fallback is
 * worse than a crash. Every fallback in `exchange.ts` records its reason here.
 */
// `cli` is the Binance Skill Hub rail (src/lib/skillhub.ts), which sits
// between MCP and REST. The name stays `McpUse` because this record is what
// /api/agent-os publishes as the Agent OS usage view, and all three rails
// answer the same question: which one actually served this read.
type McpUse = { via: "mcp" | "cli" | "rest"; tool?: string; reason?: string; at: number };
const uses: Record<string, McpUse> = {};

export function noteMcpUse(operation: string, use: Omit<McpUse, "at">): void {
  uses[operation] = { ...use, at: Date.now() };
}

export function mcpUsage(): Record<string, McpUse> {
  return { ...uses };
}

/** The Agent OS tools this product actually calls. Published in the manifest. */
export const AGENT_OS_TOOLS = {
  prices: ["spot_tickerPrice", "spot.tickerPrice"],
  candles: ["spot_klines", "spot.klines"],
  account: ["spot_getAccount", "spot.getAccount"],
} as const;

/**
 * One-shot health check for the console and `scripts/mcp-smoke.ts`: is the rail
 * up, and which of the tools we depend on are actually published to this token.
 */
export async function mcpHealth(): Promise<{
  mode: "live" | "off";
  reason: string;
  toolCount: number;
  resolved: Record<string, string | null>;
  error?: string;
}> {
  const { mode, reason } = mcpMode();
  if (mode === "off") return { mode, reason, toolCount: 0, resolved: {} };

  try {
    const names = await mcpTools();
    const resolved: Record<string, string | null> = {};
    for (const [label, candidates] of Object.entries(AGENT_OS_TOOLS)) {
      resolved[label] = await resolveTool([...candidates]);
    }
    return { mode, reason, toolCount: names.length, resolved };
  } catch (err) {
    return {
      mode: "off",
      reason: "reachable check failed",
      toolCount: 0,
      resolved: {},
      error: String(err),
    };
  }
}
