/**
 * The B402 half of the payment seam: how an Omon 402 challenge is shaped when
 * the rail is Binance OnchainPay instead of the public x402 facilitator.
 *
 * Split out of x402.ts on purpose. x402.ts stays the seam every route imports —
 * routes still never touch a scheme or a facilitator — and this file holds the
 * one thing that is genuinely rail-specific: B402 does not accept the same
 * route config the public rail does.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 *
 * X402_RAIL=b402 was wired in before this, and it looked finished: the
 * facilitator, the scheme and the credential check were all there. It was not.
 * `paidRoute()` handed B402 the same `price: "$0.01"` string the public rail
 * takes, and @bnb-chain/b402's `B402ExactServerScheme.parsePrice` rejects a
 * monetary price outright unless a `moneyParser` is supplied:
 *
 *     "B402 monetary prices require a moneyParser; otherwise pass
 *      { asset, amount } in atomic units"
 *
 * and `enhancePaymentRequirements` then demands `extra.assetTransferMethod`,
 * `extra.name` and `extra.version`, none of which were being sent. So the rail
 * would have booted cleanly and failed on the first paid request — the worst
 * shape of broken, because merchant credentials would have been blamed for what
 * was actually a config gap. B402 is a different route config, not a different
 * URL, and this file is where that difference lives.
 *
 * ── What is still genuinely blocked ──────────────────────────────────────────
 *
 * `signerAddress` and `spenderAddress` are NOT set here and must not be. The
 * facilitator supplies them per merchant from its RSA-gated `/supported`
 * endpoint, and the scheme merges them in itself. Guessing them would put a
 * wrong address in a real payment challenge. That endpoint needs a Binance Pay
 * merchant account, which needs a business entity (assets/spike-notes.md), so
 * the last mile is onboarding — everything before it is done and checkable.
 */
import type { RouteConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";

/**
 * One entry of a route's `accepts` list. @x402/core 2.25 does not re-export
 * `PaymentOption` from its barrels, so it is recovered from the shape that is
 * exported — which also means it cannot drift from the config the server takes.
 */
export type PaymentOption = Extract<RouteConfig["accepts"], readonly unknown[]>[number];

/**
 * The environment as these functions read it. Not `NodeJS.ProcessEnv`: that
 * type carries an index signature the tests cannot satisfy with an object
 * literal, and every one of these functions must be callable with a synthetic
 * env so the rail can be tested without touching the real process.
 */
export type Env = Readonly<Record<string, string | undefined>>;

/** B402's two supported asset-transfer methods. Permit2 Upto is unsupported by design. */
export type TransferMethod = "eip3009" | "permit2-exact";

export type B402Token = {
  /** ERC-20 the merchant settles in, on BSC. */
  address: string;
  /** EIP-712 domain name of that token — must match the contract exactly. */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  decimals: number;
  method: TransferMethod;
};

/** Env var names the SDK's own `B402Client.fromEnv` requires. Names only — values never leave the process. */
export const B402_CREDENTIAL_VARS = [
  "B402_BASE_URL",
  "B402_CLIENT_ID",
  "B402_ACCESS_TOKEN",
  "B402_PRIVATE_KEY",
] as const;

/** Env vars this file needs to shape the challenge. Separate from credentials: a merchant states these. */
export const B402_TOKEN_VARS = ["B402_TOKEN_ADDRESS", "B402_TOKEN_NAME"] as const;

/**
 * Decimal string -> atomic integer string, exactly.
 *
 * Deliberately string math. `0.01 * 1e18` in float is 9999999999999998, which
 * is a real amount that is not the advertised price, and a payment challenge
 * that disagrees with the price it printed is the one bug here that costs a
 * buyer money. Over-precision throws rather than truncating for the same
 * reason: silently rounding a price down is still quoting a price nobody set.
 */
export function toAtomicUnits(amount: string | number, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`b402: token decimals must be an integer 0..36 (got ${decimals})`);
  }
  const raw = String(amount).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`b402: price ${JSON.stringify(raw)} is not a positive decimal number`);
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `b402: price ${raw} has ${frac.length} decimal places but the token has only ${decimals}. ` +
        `Raise B402_TOKEN_DECIMALS or quote a coarser X402_PRICE — rounding it here would ` +
        `charge a price nobody configured.`,
    );
  }
  const atomic = `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  if (atomic === "0") {
    throw new Error(`b402: price ${raw} is zero in atomic units; B402 requires a positive amount`);
  }
  return atomic;
}

/**
 * Token config from env, with BSC-USD (BEP-20 USDT, 18 decimals) as the
 * default shape. The address default is empty rather than a plausible-looking
 * constant: an unset merchant token must read as unset, not as a guess that
 * happens to be a real contract.
 */
export function b402Token(env: Env = process.env): B402Token {
  const method = env.B402_TRANSFER_METHOD ?? "eip3009";
  if (method !== "eip3009" && method !== "permit2-exact") {
    throw new Error(
      `b402: B402_TRANSFER_METHOD must be 'eip3009' or 'permit2-exact' (got ${JSON.stringify(method)})`,
    );
  }
  return {
    address: env.B402_TOKEN_ADDRESS ?? "",
    name: env.B402_TOKEN_NAME ?? "",
    version: env.B402_TOKEN_VERSION ?? "1",
    decimals: Number(env.B402_TOKEN_DECIMALS ?? "18"),
    method,
  };
}

/**
 * The `accepts` entry a B402 route advertises.
 *
 * Two differences from the public rail, both required by the SDK:
 *   price  an { asset, amount } pair in atomic units, never "$0.01"
 *   extra  assetTransferMethod + the token's EIP-712 name and version
 *
 * `signerAddress`/`spenderAddress` are omitted — see the header. The scheme
 * fills them from the facilitator's `/supported` at challenge time.
 */
export function b402Accepts(args: {
  payTo: string;
  network: Network;
  price: string | number;
  token: B402Token;
}): PaymentOption {
  const { payTo, network, price, token } = args;
  return {
    scheme: "exact",
    payTo,
    network,
    price: { asset: token.address, amount: toAtomicUnits(price, token.decimals) },
    extra: {
      assetTransferMethod: token.method,
      name: token.name,
      version: token.version,
    },
  };
}

export type B402Readiness = {
  /** live = credentials present and rail selected. preview = mapped, advertised, not settling. */
  status: "live" | "preview" | "off";
  configured: boolean;
  credentials: { present: string[]; missing: string[] };
  token: { present: string[]; missing: string[]; resolved: B402Token };
  /** The exact accepts entry this process would publish, or the reason it cannot build one. */
  challenge: PaymentOption | null;
  challengeError: string | null;
  /** Plain-English statement of the one thing still gated on Binance. */
  blocked: string | null;
};

/**
 * A credential-free preflight of the B402 rail.
 *
 * The point is that "we do not have merchant access yet" stops being a claim
 * and becomes a report: which variables are set, which are not, and the
 * fully-built challenge Omon would issue the moment they are. Everything up to
 * the facilitator handshake is computed here with no network call and no
 * secret, so the mapping is verifiable by anyone with a clone.
 *
 * Values are never returned — only variable names and whether they are set.
 */
export function b402Readiness(
  rail: string,
  payTo: string,
  network: Network,
  price: string | number,
  env: Env = process.env,
): B402Readiness {
  // `||` not `??`: a dotenv line like `B402_CLIENT_ID=` yields "", which is absent.
  const isSet = (name: string) =>
    name === "B402_PRIVATE_KEY"
      ? Boolean(env.B402_PRIVATE_KEY || env.B402_PRIVATE_KEY_B64)
      : Boolean(env[name]);

  const credentials = {
    present: B402_CREDENTIAL_VARS.filter(isSet) as string[],
    missing: B402_CREDENTIAL_VARS.filter((n) => !isSet(n)) as string[],
  };

  let resolved: B402Token;
  let challenge: PaymentOption | null = null;
  let challengeError: string | null = null;
  try {
    resolved = b402Token(env);
    challenge = b402Accepts({ payTo, network, price, token: resolved });
    // Built, but only meaningful if the merchant actually stated a token.
    if (!resolved.address || !resolved.name) {
      challengeError =
        "Shape is correct but B402_TOKEN_ADDRESS/B402_TOKEN_NAME are unset, so the asset is a placeholder.";
    }
  } catch (err) {
    resolved = { address: "", name: "", version: "1", decimals: 18, method: "eip3009" };
    challengeError = err instanceof Error ? err.message : String(err);
  }

  const token = {
    present: B402_TOKEN_VARS.filter((n) => Boolean(env[n])) as string[],
    missing: B402_TOKEN_VARS.filter((n) => !env[n]) as string[],
    resolved,
  };

  const configured = credentials.missing.length === 0 && token.missing.length === 0;
  const status: B402Readiness["status"] =
    rail === "b402" && configured ? "live" : rail === "b402" || rail === "b402-preview" ? "preview" : "off";

  return {
    status,
    configured,
    credentials,
    token,
    challenge,
    challengeError,
    blocked: configured
      ? null
      : "B402 merchant onboarding. The facilitator's /supported endpoint is RSA-gated per merchant and " +
        "supplies signerAddress/spenderAddress, which cannot be guessed. Everything before that handshake " +
        "is mapped and shown above.",
  };
}
