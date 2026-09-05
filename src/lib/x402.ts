/**
 * The paid-endpoint seam. Only this file knows which payment rail we are on.
 *
 *   X402_RAIL=testnet -> public x402 facilitator on Base Sepolia. Permissionless.
 *   X402_RAIL=b402    -> Binance OnchainPay B402 on BSC. Needs merchant credentials
 *                        (B402_CLIENT_ID / B402_ACCESS_TOKEN / RSA B402_PRIVATE_KEY).
 *
 * Routes never import a scheme or a facilitator directly. Swapping rails is one
 * env var, so the demo keeps working while merchant onboarding is pending.
 */
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RouteConfig } from "@x402/core/server";
import type { Network, SchemeNetworkServer } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";

export type Rail = "testnet" | "b402";

export const rail = (process.env.X402_RAIL ?? "testnet") as Rail;

export const payTo = (process.env.PAY_TO_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

/** Chain the 402 challenge advertises. Base Sepolia unless we are on B402/BSC. */
export const network = (
  rail === "b402"
    ? (process.env.B402_NETWORK ?? "eip155:56")
    : (process.env.X402_NETWORK ?? "eip155:84532")
) as Network;

// Stored WITHOUT the "$" — Next expands `$0` in .env files to an empty string.
export const price = `$${process.env.X402_PRICE ?? "0.01"}`;

let serverPromise: Promise<x402ResourceServer> | null = null;

async function build(): Promise<x402ResourceServer> {
  if (rail === "b402") {
    // Imported lazily so a missing RSA credential cannot break the testnet rail.
    const { B402Client, B402ExactServerScheme, B402FacilitatorClient } = await import(
      "@bnb-chain/b402/server"
    );
    const transport = B402Client.fromEnv();
    if (!transport) {
      throw new Error(
        "X402_RAIL=b402 but B402 credentials are missing. Set B402_BASE_URL, " +
          "B402_CLIENT_ID, B402_ACCESS_TOKEN and B402_PRIVATE_KEY, or use X402_RAIL=testnet.",
      );
    }
    const facilitator = new B402FacilitatorClient({
      client: transport,
      onSettlementUnknown: (event: unknown) => {
        console.error("[b402] settlement UNKNOWN — reconcile before serving again", event);
      },
    });
    // @bnb-chain/b402@0.2.1 targets @x402/core ^2.19; core 2.25 widened
    // SchemeNetworkServer. Cast until the provider catches up — see
    // assets/spike-notes.md.
    const scheme = new B402ExactServerScheme({ facilitator }) as unknown as SchemeNetworkServer;
    const server = new x402ResourceServer(facilitator).register("eip155:*", scheme);
    await server.initialize();
    return server;
  }

  const facilitator = new HTTPFacilitatorClient({
    url: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  });
  return new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
}

/** One resource server per process. */
export function paymentServer(): Promise<x402ResourceServer> {
  serverPromise ??= build();
  return serverPromise;
}

/** Route config for a paid endpoint, described once. */
export function paidRoute(description: string): RouteConfig {
  return {
    accepts: [{ scheme: "exact", price, network, payTo }],
    description,
    mimeType: "application/json",
  };
}
