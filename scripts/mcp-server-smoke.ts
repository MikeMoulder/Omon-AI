/**
 * Smoke test for Omon's own MCP server.
 *
 *   npx tsx scripts/mcp-server-smoke.ts
 *   npx tsx scripts/mcp-server-smoke.ts --base http://localhost:3100 --verbose
 *
 * The mirror image of mcp-smoke.ts. That script asserts Omon can *read* Binance
 * over MCP; this one asserts another agent can read *Omon* over MCP.
 *
 * It drives the endpoint over real HTTP rather than importing the handler,
 * because the thing being proven is that an outside client can complete a
 * handshake and call a tool — and an in-process call proves none of that.
 *
 * The paid tools are exercised WITHOUT payment on purpose. A 402 arriving as a
 * well-formed JSON-RPC error carrying the challenge is the passing case: it is
 * the evidence that the payment rail reaches into the MCP surface rather than
 * stopping at the HTTP one.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

const verbose = process.argv.includes("--verbose");
const baseArg = process.argv.indexOf("--base");
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : "http://localhost:3100";
const URL_ = `${BASE.replace(/\/$/, "")}/api/mcp`;

let failures = 0;
function check(label: string, okay: boolean, detail = ""): void {
  console.log(`${okay ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!okay) failures += 1;
}

let nextId = 1;
async function rpc(
  method: string,
  params?: Record<string, unknown>,
  accept = "application/json",
): Promise<{ status: number; body: any }> {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });

  const text = await res.text();
  if (accept.includes("event-stream")) return { status: res.status, body: text };

  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function main(): Promise<void> {
  console.log(`\nOmon MCP server: ${URL_}\n`);

  // ── handshake ─────────────────────────────────────────────────────────────
  console.log("handshake");
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "omon-smoke", version: "1.0.0" },
  });
  check("initialize answers", init.status === 200, `HTTP ${init.status}`);
  check(
    "server reports protocol 2025-06-18",
    init.body?.result?.protocolVersion === "2025-06-18",
    init.body?.result?.protocolVersion,
  );
  check("server names itself", init.body?.result?.serverInfo?.name === "omon");
  check("server advertises the tools capability", Boolean(init.body?.result?.capabilities?.tools));

  // A notification takes no response at all.
  const note = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  check("notifications/initialized gets 202 and no body", note.status === 202, `HTTP ${note.status}`);

  // ── tools/list ────────────────────────────────────────────────────────────
  console.log("\ntools");
  const list = await rpc("tools/list");
  const tools: Array<{ name: string; inputSchema?: unknown }> = list.body?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check("tools/list returns six tools", tools.length === 6, names.join(", "));
  for (const expected of [
    "omon_rails",
    "omon_pnl",
    "omon_positions",
    "omon_gate",
    "omon_intel",
    "omon_signal",
  ]) {
    check(`${expected} is listed`, names.includes(expected));
  }
  check(
    "every tool declares an input schema",
    tools.length > 0 && tools.every((t) => typeof t.inputSchema === "object" && t.inputSchema !== null),
  );

  // ── the four free tools ───────────────────────────────────────────────────
  console.log("\nfree tools, no payment");

  const rails = await rpc("tools/call", { name: "omon_rails", arguments: {} });
  const railsData = rails.body?.result?.structuredContent;
  check("omon_rails answers without payment", rails.body?.result?.isError === false);
  check("omon_rails names the rail that served the last read", Boolean(railsData?.lastReadVia));
  check(
    "omon_rails carries the reachability finding",
    Array.isArray(railsData?.reachability?.prodOnly) && railsData.reachability.prodOnly.length > 0,
    verbose ? JSON.stringify(railsData?.reachability?.prodOnly) : "",
  );

  const pnl = await rpc("tools/call", { name: "omon_pnl", arguments: {} });
  const pnlData = pnl.body?.result?.structuredContent;
  check("omon_pnl answers", pnl.body?.result?.isError === false);
  check("omon_pnl reports a fill count", Number.isFinite(pnlData?.fillCount), String(pnlData?.fillCount));
  check("omon_pnl splits by venue", Boolean(pnlData?.spot && pnlData?.futures));

  const pos = await rpc("tools/call", { name: "omon_positions", arguments: {} });
  check("omon_positions answers", pos.body?.result?.isError === false);
  check(
    "omon_positions returns both venues as arrays",
    Array.isArray(pos.body?.result?.structuredContent?.spot) &&
      Array.isArray(pos.body?.result?.structuredContent?.futures),
  );

  const gate = await rpc("tools/call", { name: "omon_gate", arguments: { limit: 5 } });
  const gateData = gate.body?.result?.structuredContent;
  check("omon_gate answers", gate.body?.result?.isError === false);
  check("omon_gate publishes the limits the gate enforces", Boolean(gateData?.limits?.maxTradeUsd));
  check(
    "omon_gate reports the two new halts",
    Number.isFinite(gateData?.limits?.dailyLossHaltUsd) &&
      Number.isFinite(gateData?.limits?.maxDrawdownUsd),
  );
  check(
    "omon_gate honours its limit argument",
    Array.isArray(gateData?.decisions) && gateData.decisions.length <= 5,
  );
  if (verbose && gateData?.decisions?.[0]) {
    console.log(`    latest: ${gateData.decisions[0].decision} — ${gateData.decisions[0].reason}`);
  }

  // ── the two paid tools, unpaid ────────────────────────────────────────────
  console.log("\npaid tools, deliberately unpaid");
  for (const name of ["omon_intel", "omon_signal"]) {
    const res = await rpc("tools/call", { name, arguments: { limit: 1 } });
    const error = res.body?.error;
    check(`${name} refuses an unpaid call`, Boolean(error), error ? "" : "it answered anyway");
    check(`${name} refuses with -32002`, error?.code === -32002, String(error?.code));
    check(`${name} attaches the challenge`, Boolean(error?.data));
    check(`${name} says where to pay`, typeof error?.data?.httpPath === "string", error?.data?.httpPath);
    if (verbose && error?.data) {
      console.log(`    ${name} data keys: ${Object.keys(error.data).join(", ")}`);
    }
  }

  // ── protocol edges ────────────────────────────────────────────────────────
  console.log("\nprotocol");
  const unknown = await rpc("tools/call", { name: "omon_nope", arguments: {} });
  check("an unknown tool is a -32602", unknown.body?.error?.code === -32602);
  check("an unknown tool lists what does exist", Array.isArray(unknown.body?.error?.data?.available));

  const badMethod = await rpc("does/not/exist");
  check("an unknown method is a -32601", badMethod.body?.error?.code === -32601);

  const sse = await rpc("tools/list", undefined, "text/event-stream");
  check(
    "the same call is served as SSE when asked",
    typeof sse.body === "string" && sse.body.startsWith("event: message\ndata: "),
    verbose ? String(sse.body).slice(0, 40) : "",
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nThe server did not answer. Is it running?");
  console.error(`  npx next start -p 3100    then    npx tsx scripts/mcp-server-smoke.ts\n`);
  console.error(err);
  process.exit(1);
});
