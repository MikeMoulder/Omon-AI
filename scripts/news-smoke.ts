/**
 * Smoke test for the news seam and the intel cache:
 *   npx tsx scripts/news-smoke.ts           fixtures, no network, no key
 *   npx tsx scripts/news-smoke.ts --live    real RSS feeds + real Gemini calls
 *   npx tsx scripts/news-smoke.ts --feeds   feeds only, no model calls
 *
 * Proves the whole front half of the chain: RSS -> headlines -> structured
 * intel -> cache -> what the paid endpoint would serve. Also asserts the TTL
 * and the dedupe guard, because both exist to protect the Gemini free quota and
 * a silent regression there does not show up until the account locks out.
 */
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"], quiet: true });

if (process.argv.includes("--live")) process.env.DEMO_MODE = "live";
const FEEDS_ONLY = process.argv.includes("--feeds");

import { fetchHeadlines, feedErrors, newsMode } from "@/lib/news";
import { getIntel, intelCacheStatus, refreshIntel } from "@/lib/intel-cache";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const nm = newsMode();
  console.log(`[news-smoke] news: ${nm.mode.toUpperCase()} (${nm.reason})`);

  console.log("\n--- headlines ---");
  const t0 = Date.now();
  const headlines = await fetchHeadlines(6);
  console.log(`fetched ${headlines.length} in ${Date.now() - t0}ms`);
  for (const h of headlines) {
    console.log(`  [${h.source}] ${h.title}`);
    console.log(`     ${h.url}`);
  }

  check("returns at least one headline", headlines.length > 0);
  check("every headline has a usable url", headlines.every((h) => h.url.startsWith("http")));
  check("every headline has a title", headlines.every((h) => h.title.length > 3));
  check(
    "urls are unique",
    new Set(headlines.map((h) => h.url)).size === headlines.length,
  );
  check(
    "publishedAt parses as a date",
    headlines.every((h) => !Number.isNaN(Date.parse(h.publishedAt))),
  );

  // The fixture fallback is the whole point of the seam and also the thing most
  // likely to hide a break: a parse bug once returned fixtures while the banner
  // still said LIVE. In live mode, fixture URLs are a failure, not a pass.
  if (nm.mode === "live") {
    check("no feed errors", feedErrors().length === 0, feedErrors().join(" | "));
    check(
      "headlines are live, not fixtures",
      headlines.every((h) => !h.url.includes("example.com")),
    );
  }

  if (FEEDS_ONLY) return;

  console.log("\n--- refresh (news -> intel -> cache) ---");
  const t1 = Date.now();
  await refreshIntel({ force: true });
  const took = Date.now() - t1;
  const status = intelCacheStatus();
  console.log(`refreshed in ${took}ms`, JSON.stringify(status, null, 2));

  check("cache holds rows after refresh", status.rows > 0);
  check("cache is fresh immediately after refresh", status.fresh);
  check("ttl is five minutes", status.ttlMs === 5 * 60_000, `${status.ttlMs}ms`);

  console.log("\n--- what /api/intel would serve ---");
  const served = getIntel(3);
  console.log(JSON.stringify(served, null, 2));
  check("serves from cache, not the fixture", served.source === "cache");
  check("served rows are flagged fresh", served.fresh);

  console.log("\n--- dedupe / quota guard ---");
  const before = intelCacheStatus().rows;
  const t2 = Date.now();
  await refreshIntel({ force: true });
  const secondTook = Date.now() - t2;
  const after = intelCacheStatus().rows;
  console.log(`second forced refresh: ${before} -> ${after} rows in ${secondTook}ms`);

  // A second refresh is allowed to grow the cache — it works through the rest
  // of the feed, capped by INTEL_MAX_NEW. What it must never do is pay for the
  // same story twice, so the invariant is unique source URLs, not a frozen count.
  const urls = getIntel(50).intel.map((i) => i.sourceUrl);
  check(
    "never analyses the same story twice",
    new Set(urls).size === urls.length,
    `${urls.length} rows, ${new Set(urls).size} unique`,
  );
  check("respects the per-refresh cap", after - before <= 3, `+${after - before}`);

  console.log("\n--- ttl guard ---");
  const t3 = Date.now();
  await refreshIntel();
  check("skips work while fresh", Date.now() - t3 < 50, `${Date.now() - t3}ms`);
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\n[news-smoke] threw:", err);
    process.exit(1);
  });
