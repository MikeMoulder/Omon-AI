/**
 * Spike 2, buyer half: an OUTSIDE client that pays a 402 and gets the data.
 *
 * This proves the seller route end to end without Claude Desktop in the loop.
 * Run the app, then:  node scripts/pay.mjs /api/intel
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

const base = process.env.RESOURCE_SERVER_URL || "http://localhost:3000";
const path = process.argv[2] || "/api/intel";
const url = `${base}${path}`;

const client = new x402Client();
client.setSpendControls({ maxAmountPerPayment: "$1" });
client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(key)));

const http = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`[buyer] GET ${url}`);
const t0 = performance.now();
const res = await fetchWithPayment(url, { method: "GET" });
const out = await http.processResponse(res);
console.dir(out, { depth: null });
console.log(`[buyer] done in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
