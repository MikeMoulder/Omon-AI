/**
 * The paid-endpoint seam. Only this file knows which payment rail we are on.
 *
 *   X402_RAIL=testnet       public x402 facilitator on Base Sepolia. Permissionless.
 *   X402_RAIL=b402          Binance OnchainPay B402 on BSC. Needs merchant credentials
 *                           (B402_CLIENT_ID / B402_ACCESS_TOKEN / RSA B402_PRIVATE_KEY).
 *   X402_RAIL=b402-preview  B402 mapped and published, settling on the public rail.
 *                           The mode for demoing B402 before onboarding clears.
 *
 * Routes never import a scheme or a facilitator directly. Swapping rails is one
 * env var, so the demo keeps working while merchant onboarding is pending.
 *
 * ── On b402-preview, and why it is not a lie ─────────────────────────────────
 *
 * The tempting version of "feature B402 before we have access" is to advertise
 * a BSC challenge and quietly settle somewhere else. That would hand a buyer a
 * payment requirement it cannot pay, on a chain nothing is watching.
 *
 * So preview mode keeps exactly one challenge payable — the Base Sepolia one
 * that actually settles — and publishes the B402 challenge *alongside* it,
 * labelled, as `b402Preview`. Everything about the B402 mapping is real and
 * computed by the same function the live rail uses (`b402Accepts`), so what a
 * viewer sees in preview is byte-for-byte what a buyer would be handed on BSC.
 * Nothing claims B402 settles until it does.
 *
 * `rail === "b402"` still hard-fails without credentials. That is deliberate:
 * degrading a *selected* money rail to a different one behind the operator's
 * back is how a typo'd variable name becomes a silent semantic swap.
 */
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RouteConfig } from "@x402/core/server";
import type { Network, SchemeNetworkServer } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { b402Accepts, b402Readiness, b402Token, type PaymentOption } from "@/lib/b402";
import { SERVICE_NAME, SERVICE_TAGS } from "@/lib/service";

export type Rail = "testnet" | "b402" | "b402-preview";

export const rail = (process.env.X402_RAIL ?? "testnet") as Rail;

/** Whether the B402 mapping is being published at all — live or as a preview. */
export const b402Selected = rail === "b402" || rail === "b402-preview";

/**
 * Which rail money actually moves on. Not the same as `rail`: b402-preview
 * advertises B402 but settles on the public facilitator, and every downstream
 * consumer that cares about real settlement (the ledger, the disclosure) must
 * read this rather than the display value.
 */
export const settlementRail: "testnet" | "b402" = rail === "b402" ? "b402" : "testnet";

export const payTo = (process.env.PAY_TO_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

/**
 * Chain the payable 402 challenge advertises. BSC only when B402 genuinely
 * settles — in preview the payable challenge is still Base Sepolia, because
 * that is the chain that will actually accept the payment.
 */
export const network = (
  settlementRail === "b402"
    ? (process.env.B402_NETWORK ?? "eip155:56")
    : (process.env.X402_NETWORK ?? "eip155:84532")
) as Network;

/** The chain the B402 mapping targets, live or previewed. */
export const b402Network = (process.env.B402_NETWORK ?? "eip155:56") as Network;

// Stored WITHOUT the "$" — Next expands `$0` in .env files to an empty string.
export const price = `$${process.env.X402_PRICE ?? "0.01"}`;

/** The same figure as a number, for the ledger. `price` is display, this is arithmetic. */
export const priceUsd = Number(process.env.X402_PRICE ?? "0.01");

/**
 * What a buyer actually pays in. Display only — the 402 challenge names the
 * asset itself, and nothing downstream converts using this string.
 *
 * Rail-aware, and the b402 case is not symmetry for its own sake. The public
 * rail settles test USDC on Base Sepolia, which is knowable here. B402 does
 * not work that way: the asset is a token contract the facilitator supplies
 * per merchant via `/supported`, and that endpoint is RSA-gated to merchants,
 * so this process genuinely cannot know the symbol. Printing "USDC" there
 * would put a claim on the console — and in the video — that nothing verified,
 * next to a settlement on BNB Smart Chain. Say "token" and be honestly vague
 * instead, or set X402_TOKEN_SYMBOL once the merchant account states it.
 *
 * B402_TOKEN_NAME is accepted as the next-best source: it is the token's own
 * EIP-712 domain name, so when a merchant has stated it, it is not a guess.
 */
export const priceToken =
  process.env.X402_TOKEN_SYMBOL ??
  (settlementRail === "b402" ? (process.env.B402_TOKEN_NAME || "token") : "USDC");

/** Credential-free report on the B402 rail: what is mapped, what is missing, what it would publish. */
export function b402Status() {
  return b402Readiness(rail, payTo, b402Network, process.env.X402_PRICE ?? "0.01");
}

/**
 * The B402 `accepts` entry, built by the same code path the live rail uses.
 * Returns null if the token config cannot produce a valid one, so a caller
 * shows the error rather than a half-built challenge.
 */
export function b402Challenge(): PaymentOption | null {
  try {
    return b402Accepts({
      payTo,
      network: b402Network,
      price: process.env.X402_PRICE ?? "0.01",
      token: b402Token(),
    });
  } catch {
    return null;
  }
}

/**
 * The published B402 block: one document, served both inside the manifest and
 * standalone at /api/b402, so the two can never disagree about what is mapped.
 *
 * Deliberately shaped as evidence rather than a boast. `wouldAdvertise` is the
 * real challenge built by the real function; `missing` names the env vars that
 * are unset; `blocked` says the one thing Binance still has to grant. A reader
 * can tell mapped-and-waiting apart from not-built, which a status pill alone
 * never conveys.
 */
export function b402Report(): Record<string, unknown> {
  const status = b402Status();
  return {
    rail,
    settlementRail,
    status: status.status,
    settling: settlementRail === "b402",
    network: b402Network,
    transferMethod: status.token.resolved.method,
    provider: "@bnb-chain/b402",
    // What a buyer on BSC would be handed. Built by b402Accepts(), the same
    // function the live rail calls — this is not a hand-written sample.
    wouldAdvertise: b402Challenge(),
    ...(status.challengeError ? { challengeNote: status.challengeError } : {}),
    configured: status.configured,
    missing: {
      credentials: status.credentials.missing,
      token: status.token.missing,
    },
    present: {
      credentials: status.credentials.present,
      token: status.token.present,
    },
    blocked: status.blocked,
    docs: "https://github.com/bnb-chain/mpp-sdk/tree/main/packages/b402",
  };
}

let serverPromise: Promise<x402ResourceServer> | null = null;

async function build(): Promise<x402ResourceServer> {
  if (rail === "b402") {
    // Imported lazily so a missing RSA credential cannot break the testnet rail.
    const { B402Client, B402ExactServerScheme, B402FacilitatorClient } =
      await import("@bnb-chain/b402/server");
    const transport = B402Client.fromEnv();
    if (!transport) {
      throw new Error(
        "X402_RAIL=b402 but B402 credentials are missing. Set B402_BASE_URL, " +
          "B402_CLIENT_ID, B402_ACCESS_TOKEN and B402_PRIVATE_KEY, or use " +
          "X402_RAIL=b402-preview to publish the B402 mapping while settling on the public rail.",
      );
    }
    const facilitator = new B402FacilitatorClient({
      client: transport,
      onSettlementUnknown: (event: unknown) => {
        console.error("[b402] settlement UNKNOWN, reconcile before serving again", event);
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

  if (rail === "b402-preview") {
    // Said once, at boot, where an operator will see it. Preview mode is easy
    // to leave switched on by accident and it does not take Binance money.
    console.warn(
      "[x402] rail=b402-preview: the B402 mapping is published and inspectable at " +
        "/api/b402, but payments settle on the public x402 facilitator. " +
        "Set X402_RAIL=b402 with merchant credentials to settle on BSC.",
    );
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

/**
 * The payable `accepts` entry for the rail in force.
 *
 * On the live B402 rail this is the atomic-unit/`extra` shape the B402 scheme
 * requires — see src/lib/b402.ts for why the plain "$0.01" form is rejected
 * there. On the public rail it stays the monetary form the EVM scheme parses.
 */
function accepts(): PaymentOption {
  if (settlementRail === "b402") {
    return b402Accepts({
      payTo,
      network,
      price: process.env.X402_PRICE ?? "0.01",
      token: b402Token(),
    });
  }
  return { scheme: "exact", price, network, payTo };
}

/**
 * Route config for a paid endpoint, described once.
 *
 * `serviceName` and `tags` are not decoration. Omon is not listed in any
 * directory, so the 402 challenge itself has to carry the metadata a directory
 * would have published — an agent handed only the URL still learns what this
 * service is and what it sells. `preview` goes further: instead of the default
 * empty `{}` body, an unpaid request gets a redacted sample and a pointer to
 * the free manifest, which is what makes the endpoint explorable rather than
 * merely payable.
 */
export function paidRoute(
  description: string,
  opts: { preview?: () => unknown; tags?: string[] } = {},
): RouteConfig {
  return {
    accepts: [accepts()],
    description,
    mimeType: "application/json",
    serviceName: SERVICE_NAME,
    tags: opts.tags ?? SERVICE_TAGS,
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        error: "payment required",
        service: SERVICE_NAME,
        description,
        price,
        network,
        payTo,
        // A machine that got here without knowing what we are can find out.
        manifest: "/.well-known/x402",
        howToPay:
          "Retry this request with an X-PAYMENT header per the x402 spec. The 402 challenge carries the full payment requirements.",
        preview: opts.preview?.() ?? null,
        // Published only in preview mode, and named so no client can mistake it
        // for something payable. A B402 buyer can read the exact requirements
        // it will be handed on BSC before onboarding clears.
        ...(rail === "b402-preview"
          ? {
              b402Preview: {
                status: "not settling — B402 merchant onboarding pending",
                wouldAdvertise: b402Challenge(),
                readiness: "/api/b402",
              },
            }
          : {}),
      },
    }),
  };
}
