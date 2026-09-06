/**
 * Tests for the Binance OnchainPay (B402) mapping.
 *   npx tsx scripts/b402-test.ts
 * No network, no credentials, no merchant account. Runs in milliseconds.
 *
 * These exist because B402 cannot be exercised end to end from here — the
 * facilitator handshake is RSA-gated to a merchant account we do not have. What
 * CAN be checked without it is everything up to that handshake: that the price
 * converts to atomic units exactly, that the challenge carries the three `extra`
 * fields @bnb-chain/b402 demands, and that selecting the rail does not quietly
 * change what the public rail publishes. That is the difference between "B402
 * is mapped" as a claim and as a fact.
 *
 * The specific bug these lock down: the first version of the B402 rail handed
 * the scheme `price: "$0.01"`, which `B402ExactServerScheme.parsePrice` rejects
 * outright. It would have booted clean and failed on the first paid request.
 */
import assert from "node:assert/strict";
import { B402ExactServerScheme } from "@bnb-chain/b402/server";
import { b402Accepts, b402Readiness, b402Token, toAtomicUnits } from "@/lib/b402";
import type { Network } from "@x402/core/types";

const PAY_TO = "0x00000000000000000000000000000000000000A1";
const BSC = "eip155:56" as Network;

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log("\ntoAtomicUnits");

check("converts a cent to 18-decimal atomic units exactly", () => {
  // The float route gives 9999999999999998. String math must not.
  assert.equal(toAtomicUnits("0.01", 18), "10000000000000000");
});

check("handles 6-decimal tokens", () => {
  assert.equal(toAtomicUnits("0.01", 6), "10000");
  assert.equal(toAtomicUnits("1", 6), "1000000");
});

check("accepts a leading $ and a numeric input", () => {
  assert.equal(toAtomicUnits("$0.5", 2), "50");
  assert.equal(toAtomicUnits(2, 2), "200");
});

check("never returns a leading zero", () => {
  assert.equal(toAtomicUnits("0.1", 2), "10");
  assert.match(toAtomicUnits("0.000001", 18), /^1000000000000$/);
});

check("refuses to silently round a price the token cannot express", () => {
  assert.throws(() => toAtomicUnits("0.005", 2), /decimal places/);
});

check("refuses a price that is zero in atomic units", () => {
  assert.throws(() => toAtomicUnits("0.0", 18), /zero in atomic units/);
});

check("refuses junk rather than coercing it", () => {
  assert.throws(() => toAtomicUnits("abc", 18), /not a positive decimal/);
  assert.throws(() => toAtomicUnits("-1", 18), /not a positive decimal/);
  assert.throws(() => toAtomicUnits("1", 1.5), /decimals must be an integer/);
});

console.log("\nb402Token");

check("defaults to eip3009 with 18 decimals", () => {
  const t = b402Token({});
  assert.equal(t.method, "eip3009");
  assert.equal(t.decimals, 18);
  assert.equal(t.version, "1");
});

check("leaves an unset token address empty rather than guessing one", () => {
  assert.equal(b402Token({}).address, "");
  assert.equal(b402Token({}).name, "");
});

check("rejects a transfer method B402 does not support", () => {
  // permit2-upto is intentionally unsupported by the provider.
  assert.throws(() => b402Token({ B402_TRANSFER_METHOD: "permit2-upto" }), /eip3009/);
});

console.log("\nb402Accepts — the shape the B402 scheme actually requires");

const token = b402Token({
  B402_TOKEN_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
  B402_TOKEN_NAME: "BSC-USD",
  B402_TOKEN_VERSION: "1",
  B402_TOKEN_DECIMALS: "18",
});
const accepts = b402Accepts({ payTo: PAY_TO, network: BSC, price: "0.01", token });

check("prices in atomic units, not as a monetary string", () => {
  // The bug this file exists for: a "$0.01" here throws inside parsePrice.
  assert.equal(typeof accepts.price, "object");
  const p = accepts.price as { asset: string; amount: string };
  assert.equal(p.amount, "10000000000000000");
  assert.equal(p.asset, token.address);
  assert.match(p.amount, /^[1-9]\d*$/, "B402 requires a positive atomic-unit integer");
});

check("carries the three extra fields enhancePaymentRequirements demands", () => {
  const extra = accepts.extra as Record<string, unknown>;
  assert.equal(extra.assetTransferMethod, "eip3009");
  assert.equal(extra.name, "BSC-USD");
  assert.equal(extra.version, "1");
});

check("does NOT invent signerAddress or spenderAddress", () => {
  // The facilitator supplies both from its per-merchant /supported. A value
  // here would be a guessed address inside a real payment challenge.
  const extra = accepts.extra as Record<string, unknown>;
  assert.equal(extra.signerAddress, undefined);
  assert.equal(extra.spenderAddress, undefined);
});

check("keeps scheme, network and payee", () => {
  assert.equal(accepts.scheme, "exact");
  assert.equal(accepts.network, BSC);
  assert.equal(accepts.payTo, PAY_TO);
});

console.log("\nb402Readiness — the credential-free preflight");

const bare = b402Readiness("b402-preview", PAY_TO, BSC, "0.01", {});

check("reports preview status when the rail is selected without credentials", () => {
  assert.equal(bare.status, "preview");
  assert.equal(bare.configured, false);
});

check("names every missing variable", () => {
  assert.deepEqual(bare.credentials.missing, [
    "B402_BASE_URL",
    "B402_CLIENT_ID",
    "B402_ACCESS_TOKEN",
    "B402_PRIVATE_KEY",
  ]);
  assert.deepEqual(bare.token.missing, ["B402_TOKEN_ADDRESS", "B402_TOKEN_NAME"]);
});

check("still builds a challenge, and says why it is a placeholder", () => {
  assert.notEqual(bare.challenge, null);
  assert.match(String(bare.challengeError), /placeholder/);
});

check("states the one thing that is actually blocked", () => {
  assert.match(String(bare.blocked), /onboarding/);
});

check("treats an empty env var as absent, the way dotenv writes it", () => {
  // `B402_CLIENT_ID=` in a .env file yields "", which is not a credential.
  const r = b402Readiness("b402", PAY_TO, BSC, "0.01", {
    B402_BASE_URL: "https://example.invalid",
    B402_CLIENT_ID: "",
    B402_ACCESS_TOKEN: "t",
    B402_PRIVATE_KEY: "k",
  });
  assert.ok(r.credentials.missing.includes("B402_CLIENT_ID"));
  assert.equal(r.configured, false);
});

check("accepts B402_PRIVATE_KEY_B64 in place of B402_PRIVATE_KEY", () => {
  const r = b402Readiness("b402", PAY_TO, BSC, "0.01", {
    B402_BASE_URL: "https://example.invalid",
    B402_CLIENT_ID: "c",
    B402_ACCESS_TOKEN: "t",
    B402_PRIVATE_KEY_B64: "k",
    B402_TOKEN_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
    B402_TOKEN_NAME: "BSC-USD",
  });
  assert.deepEqual(r.credentials.missing, []);
  assert.equal(r.configured, true);
  assert.equal(r.status, "live");
  assert.equal(r.blocked, null);
});

check("never returns a credential value, only its name", () => {
  const secret = "SUPER-SECRET-TOKEN";
  const r = b402Readiness("b402", PAY_TO, BSC, "0.01", {
    B402_BASE_URL: "https://example.invalid",
    B402_CLIENT_ID: "c",
    B402_ACCESS_TOKEN: secret,
    B402_PRIVATE_KEY: "k",
  });
  assert.ok(!JSON.stringify(r).includes(secret), "readiness leaked a credential value");
});

check("reports off when the rail is not selected at all", () => {
  assert.equal(b402Readiness("testnet", PAY_TO, BSC, "0.01", {}).status, "off");
});

async function main() {
  console.log("\nagainst the real @bnb-chain/b402 scheme, offline");

  /**
   * The cross-check that makes the rest of this file more than self-agreement.
   *
   * `parsePrice` is the exact function that rejected the old configuration, and
   * with an { asset, amount } price it touches no facilitator and no network — so
   * the provider's own code can be run here as the oracle. A stub facilitator is
   * supplied only because the constructor requires one; nothing below calls it.
   */
  const scheme = new B402ExactServerScheme({
    facilitator: { getSupported: async () => ({ kinds: [] }) },
  });

  await checkAsync("the provider's parsePrice accepts what b402Accepts() built", async () => {
    const parsed = await scheme.parsePrice(accepts.price as never, BSC);
    assert.equal(parsed.amount, "10000000000000000");
    // Checksummed by the provider via viem's getAddress — the value survives.
    assert.equal(parsed.asset.toLowerCase(), token.address.toLowerCase());
  });

  await checkAsync("the provider REJECTS the monetary form the public rail uses", async () => {
    // This is the bug, reproduced. "$0.01" is exactly what paidRoute() used to
    // pass on the b402 rail, and it fails here with no moneyParser configured.
    await assert.rejects(
      () => scheme.parsePrice("$0.01" as never, BSC),
      /moneyParser|atomic units/,
    );
  });

  await checkAsync("the provider accepts eip155:56 as a supported network", async () => {
    const err = scheme.validateFacilitatorSupport(BSC, {
      x402Version: 2,
      scheme: "exact",
      network: BSC,
    } as never);
    assert.equal(err, undefined);
  });
}

main().then(() => console.log(`\n${passed} passed\n`));
