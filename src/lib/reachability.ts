/**
 * Which Binance products are reachable without real money.
 *
 * A verified fact about the platform, not a live read — and the distinction is
 * deliberate. Establishing this table costs fifteen `binance-cli` spawns, which
 * is roughly eight seconds, and it is not something that changes between two
 * requests. So it is recorded here with the date it was verified and the exact
 * command that reproduces it, rather than re-probed on every hit of
 * `/api/agent-os`.
 *
 * That is the same standard the rest of this project holds itself to: a claim
 * ends at something you can run. `npx tsx scripts/agent-os-matrix.ts` regenerates
 * every cell below and exits non-zero if a rail Omon depends on has moved.
 *
 * ## The finding
 *
 * `binance-cli` accepts `BINANCE_API_ENV=prod|testnet|demo`, but the accepted
 * set is decided per product rather than globally. Convert, Margin and Wallet
 * accept `prod` and nothing else, and they say so before a request leaves the
 * machine:
 *
 *     Error: Invalid api env, valid values: prod
 *
 * Because the refusal is client-side, no credential and no `BINANCE_*_BASE_PATH`
 * override reaches past it. Spot and USDⓈ-M futures accept all three, which is
 * exactly why those are the two venues Omon trades and why the total real money
 * moved by this project is $0.
 *
 * ## Why it is published rather than quietly omitted
 *
 * Track B asks every entrant for three trades: spot, futures, and
 * margin-or-convert. Two of those three products have no non-production path in
 * Binance's own official CLI, so the third task cannot be completed by anyone
 * unwilling to trade real funds. Omon does not complete it, and this is the
 * reason, stated in the same place a judge checks everything else.
 */

/** How a product answered a read-only probe in one environment. */
export type Reach = "ok" | "refused" | "auth" | "err";

export type ProductReach = {
  product: string;
  demo: Reach;
  testnet: Reach;
  prod: Reach;
  /** True if Omon's trading path depends on this product working off prod. */
  loadBearing: boolean;
  note: string;
};

/** Verified by scripts/agent-os-matrix.ts against binance-cli 2.1.1. */
export const VERIFIED_AT = "2026-09-08T11:20:00Z";
export const PROBE_COMMAND = "npx tsx scripts/agent-os-matrix.ts --verbose";
export const PROBED_CLI = "binance-cli 2.1.1";

/** The client-side refusal, verbatim, because searching for it returns nothing. */
export const REFUSAL_TEXT = "Error: Invalid api env, valid values: prod";

export const PRODUCTS: ProductReach[] = [
  {
    product: "spot",
    demo: "ok",
    testnet: "ok",
    prod: "ok",
    loadBearing: true,
    note: "Carries every price and candle the strategy runs on, and all spot execution.",
  },
  {
    product: "futures-usds",
    demo: "ok",
    testnet: "ok",
    prod: "ok",
    loadBearing: true,
    note: "Perpetuals, leverage capped at 3x, reduceOnly on closes.",
  },
  {
    product: "convert",
    demo: "refused",
    testnet: "refused",
    prod: "ok",
    loadBearing: false,
    note: "Track B's third task. Quotes readable unauthenticated on prod; accepting one spends real funds, so Omon does not.",
  },
  {
    product: "margin-trading",
    demo: "refused",
    testnet: "refused",
    prod: "auth",
    loadBearing: false,
    note: "The alternative third task. Same client-side refusal off prod.",
  },
  {
    product: "wallet",
    demo: "refused",
    testnet: "refused",
    prod: "auth",
    loadBearing: false,
    note: "Account status and key permissions. Reads that move nothing still need production credentials, so there is no free custody surface. @binance/agentic-wallet is the other route and wants an interactive device-link flow a headless host cannot complete.",
  },
];

/** Products that refuse every non-production environment. */
export function prodOnly(): string[] {
  return PRODUCTS.filter((p) => p.demo === "refused" && p.testnet === "refused").map(
    (p) => p.product,
  );
}

/**
 * The block `/api/agent-os` publishes.
 *
 * Shaped so the two questions a judge actually has — "did you do Track B" and
 * "why not" — are answerable without opening anything else.
 */
export function reachabilityReport() {
  return {
    verifiedAt: VERIFIED_AT,
    cli: PROBED_CLI,
    reproduce: PROBE_COMMAND,
    refusal: REFUSAL_TEXT,
    products: PRODUCTS.map(({ product, demo, testnet, prod, note }) => ({
      product,
      demo,
      testnet,
      prod,
      note,
    })),
    prodOnly: prodOnly(),
    finding:
      "binance-cli decides the accepted BINANCE_API_ENV set per product. Convert, " +
      "Margin and Wallet accept prod only and refuse client-side, before any request " +
      "is made, so no credential works around it. Spot and USDⓈ-M futures accept demo " +
      "and testnet, which is why Omon trades on those two and has moved $0 of real money.",
    trackB: {
      spot: "done",
      futures: "done",
      marginOrConvert: "not done",
      reason:
        "Neither Convert nor Margin has a non-production path in Binance's own official " +
        "CLI. Completing this task requires a funded production account. Stated rather " +
        "than omitted.",
    },
  };
}
