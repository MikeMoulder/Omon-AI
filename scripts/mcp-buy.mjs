/**
 * Buy a paid MCP tool. The proof that Omon's MCP server is a business.
 *
 *   node scripts/mcp-buy.mjs                        # omon_intel, localhost
 *   node scripts/mcp-buy.mjs omon_signal            # the other paid tool
 *   RESOURCE_SERVER_URL=https://www.omon-ai.duckdns.org node scripts/mcp-buy.mjs
 *
 * The buyer half of scripts/mcp-server-smoke.ts, which only ever proves a paid
 * tool REFUSES. This one pays.
 *
 * There is no MCP-specific payment code here, and that is the point. It is the
 * same `wrapFetchWithPayment` from scripts/pay.mjs pointed at /api/mcp with a
 * JSON-RPC body, because the endpoint answers an unpaid paid-tool call with a
 * real HTTP 402 and a real `payment-required` header. An off-the-shelf x402
 * client sees a status and a header it already understands, settles, and
 * retries — and the retry's X-PAYMENT header is forwarded to the HTTP route
 * that has always known how to settle it.
 *
 * So a purchase made over MCP lands in data/purchases.jsonl next to one made
 * over HTTP, indistinguishable, because it is the same sale.
 */
import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const key = process.env.BUYER_PRIVATE_KEY;
if (!key) {
  console.error("Set BUYER_PRIVATE_KEY in .env.local (throwaway testnet key).");
  process.exit(1);
}

const base = process.env.RESOURCE_SERVER_URL || "http://localhost:3100";
const tool = process.argv[2] || "omon_intel";
const url = `${base.replace(/\/$/, "")}/api/mcp`;

const client = new x402Client();
client.setSpendControls({ maxAmountPerPayment: "$1" });
client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(key)));

const http = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`[buyer] tools/call ${tool} at ${url}`);
const t0 = performance.now();

const res = await fetchWithPayment(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: { limit: 2 } },
  }),
});

const out = await http.processResponse(res);

// processResponse returns { status, paymentStatus, body, header }. The JSON-RPC
// envelope is the body; `header` is the decoded settlement receipt.
const rpc = out?.body ?? out;
console.log(`[buyer] payment: ${out?.paymentStatus ?? "unknown"}`);

if (rpc?.error) {
  console.error(`[buyer] the call was refused: ${rpc.error.message}`);
  console.dir(rpc.error.data, { depth: 2 });
  process.exit(1);
}

const payload = rpc?.result?.structuredContent;
console.dir(payload, { depth: 3 });

// The redaction lifting is the actual proof. An unpaid call returns the same
// shape with these fields stubbed as "[paid] ...", so a real value here means
// the payment reached the resource and not merely the facilitator.
const row = payload?.intel?.[0] ?? payload?.signals?.[0];
if (row) {
  const stub = (v) => typeof v === "string" && v.startsWith("[paid]");
  const unlocked = !stub(row.summary) && !stub(row.confidence) && !stub(row.thesis) && !stub(row.side);
  console.log(`\n[buyer] paid fields: ${unlocked ? "UNLOCKED" : "STILL REDACTED"}`);
}

if (out.header) console.log("\n[buyer] settlement:", out.header);
console.log(`[buyer] done in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
