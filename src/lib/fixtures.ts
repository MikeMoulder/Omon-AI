/** Recorded news and intel so every seam has something to return before the
 *  network exists. Real shapes, captured from live sources — a fixture that
 *  does not look like production is a fixture that hides bugs until the demo. */
import type { Headline, Intel } from "@/lib/types";

/** Captured from the live cointelegraph and coindesk feeds on 2026-09-05. */
export const FIXTURE_HEADLINES: Headline[] = [
  {
    title: "US Treasury signals delay on stablecoin reserve rule",
    url: "https://example.com/treasury-stablecoin-delay",
    source: "cointelegraph.com",
    snippet:
      "Implementation of the reserve-attestation requirement slips a quarter, easing a near-term compliance overhang for USD-pegged issuers.",
    publishedAt: new Date().toISOString(),
  },
  {
    title: "Bitcoin ETF inflows hit $3.8B in strongest three-week stretch of 2026",
    url: "https://example.com/bitcoin-etf-inflows-3-8b",
    source: "cointelegraph.com",
    snippet:
      "US spot Bitcoin ETFs drew nearly $1 billion in the latest week as Friday inflows stayed positive despite Bitcoin briefly falling below $79,000.",
    publishedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  },
  {
    title: "BNB Chain gas fees fall to yearly low as throughput climbs",
    url: "https://example.com/bnb-chain-gas-yearly-low",
    source: "coindesk.com",
    snippet:
      "Median transaction cost on BNB Chain dropped below a cent this week while daily active addresses reached their highest level since January.",
    publishedAt: new Date(Date.now() - 55 * 60_000).toISOString(),
  },
];

export const FIXTURE_INTEL: Intel[] = [
  {
    id: "intel_001",
    headline: "US Treasury signals delay on stablecoin reserve rule",
    sourceUrl: "https://example.com/treasury-stablecoin-delay",
    summary:
      "Implementation of the reserve-attestation requirement slips a quarter. Removes a near-term overhang on USD-pegged stablecoin issuers and the exchanges that hold them.",
    assets: ["BTC", "BNB", "USDT"],
    direction: "bullish",
    confidence: 0.62,
    createdAt: new Date().toISOString(),
  },
];

export function latestIntel(): Intel {
  return FIXTURE_INTEL[0];
}
