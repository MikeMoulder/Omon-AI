/**
 * News seam. The only file that talks to a news provider.
 *
 * Sources are plain RSS over HTTP — no API key, no signup, no quota, nothing to
 * lock us out on the day we record. That matters more than richer metadata:
 * every keyed news API evaluated either wanted a business account or started
 * returning 401 on the free tier (cryptocompare, 2026-09-05).
 *
 * Parsing is hand-rolled. An RSS item is four fields deep and adding a parser
 * package would put another dependency in a serverless bundle to save ~30 lines.
 *
 * A dead feed is never an error the caller has to handle. Feeds are raced
 * independently, survivors are merged, and if every one of them fails the seam
 * drops to fixtures like every other seam in this directory.
 */
import type { Headline } from "@/lib/types";
import { FIXTURE_HEADLINES } from "@/lib/fixtures";

/**
 * Two independent publishers by default. One feed going quiet mid-demo then
 * looks like slow news rather than a broken product.
 *
 * Verified 2026-09-05: cointelegraph 200 / 47KB, coindesk 200 / 30KB (via one
 * redirect, so redirects must be followed), decrypt 200 / 39KB.
 */
const DEFAULT_FEEDS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss",
];

const FEEDS = (process.env.NEWS_FEEDS ?? DEFAULT_FEEDS.join(","))
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);

const TIMEOUT_MS = Number(process.env.NEWS_TIMEOUT_MS ?? 10_000);

// Some CDNs in front of these feeds refuse a bare fetch UA.
const UA = "Mozilla/5.0 (compatible; OmonIntelAgent/1.0; +https://github.com/omon)";

/**
 * Which path a call will take, and why. Same contract as llmMode() and
 * exchangeMode() so the console can render all three the same way.
 */
export function newsMode(): { mode: "fixture" | "live"; reason: string } {
  if (process.env.DEMO_MODE === "fixture") {
    return { mode: "fixture", reason: "DEMO_MODE=fixture" };
  }
  if (FEEDS.length === 0) {
    return { mode: "fixture", reason: "NEWS_FEEDS is empty" };
  }
  return { mode: "live", reason: `${FEEDS.length} rss feed(s)` };
}

/** Strip a CDATA wrapper, decode the five XML entities, collapse whitespace. */
function clean(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** First `<tag>…</tag>` inside `block`, cleaned. Empty string when absent. */
function tag(block: string, name: string): string {
  // String.raw, not a plain template literal: in a template literal `\s`
  // collapses to `s` and the class silently becomes [sS], which matches
  // nothing useful and turns every feed into an empty parse.
  const re = new RegExp(String.raw`<${name}[^>]*>([\s\S]*?)</${name}>`, "i");
  const m = block.match(re);
  return m ? clean(m[1]) : "";
}

/**
 * Prefer `<guid isPermaLink="true">` over `<link>`: both point at the article
 * but the link carries RSS utm parameters, and those would break URL dedupe by
 * making the same story look new every time a feed rebuilds its campaign tags.
 */
function itemUrl(block: string): string {
  const guid = tag(block, "guid");
  if (guid.startsWith("http")) return guid;
  const link = tag(block, "link");
  return link.startsWith("http") ? link.split("?")[0] : "";
}

function parseFeed(xml: string, source: string): Headline[] {
  const out: Headline[] = [];

  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = tag(block, "title");
    const url = itemUrl(block);
    if (!title || !url) continue;

    const pub = tag(block, "pubDate");
    const at = pub ? new Date(pub) : new Date();

    out.push({
      title,
      url,
      source,
      // A snippet is worth carrying: the headline alone is a slogan, the
      // description holds the mechanism the analyst prompt actually needs.
      snippet: tag(block, "description").slice(0, 600),
      publishedAt: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString(),
    });
  }

  return out;
}

/** Hostname as a short label — "cointelegraph.com", not the whole feed URL. */
function sourceName(feedUrl: string): string {
  try {
    return new URL(feedUrl).hostname.replace(/^www\./, "");
  } catch {
    return feedUrl;
  }
}

/** Why the last fetchHeadlines() call lost a feed, if it did. Read by the console. */
let lastFeedErrors: string[] = [];

export function feedErrors(): string[] {
  return lastFeedErrors;
}

async function fetchFeed(feedUrl: string): Promise<Headline[]> {
  const res = await fetch(feedUrl, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
    headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!res.ok) throw new Error(`${feedUrl} returned ${res.status}`);
  return parseFeed(await res.text(), sourceName(feedUrl));
}

/**
 * Newest headlines across every configured feed, deduped by URL and sorted
 * newest first. Never throws and never returns an empty array — a total feed
 * outage falls back to fixtures so the tick above it keeps its shape.
 */
export async function fetchHeadlines(limit = 10): Promise<Headline[]> {
  if (newsMode().mode === "fixture") return FIXTURE_HEADLINES.slice(0, limit);

  const settled = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f)));

  const merged: Headline[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  for (let i = 0; i < settled.length; i += 1) {
    const r = settled[i];
    if (r.status === "rejected") {
      errors.push(`${sourceName(FEEDS[i])}: ${String(r.reason)}`);
      continue;
    }
    if (r.value.length === 0) errors.push(`${sourceName(FEEDS[i])}: parsed 0 items`);
    for (const h of r.value) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      merged.push(h);
    }
  }

  // A feed that fails must never be silent. This fell back to fixtures once
  // while reporting mode LIVE, and the only symptom was example.com URLs in
  // output that otherwise looked completely correct.
  lastFeedErrors = errors;
  if (errors.length > 0) console.warn("[news] feed problems:", errors.join(" | "));

  if (merged.length === 0) return FIXTURE_HEADLINES.slice(0, limit);

  merged.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return merged.slice(0, limit);
}
