/**
 * LLM seam. The only file that talks to a model provider.
 *
 * Provider is Google Gemini over raw HTTP — no SDK, so there is no package to
 * drift and nothing extra to bundle into a serverless function. The free tier
 * is Flash-only, which is why the default model is a Flash.
 *
 * Every export falls back to fixtures when DEMO_MODE=fixture or no key is set,
 * so the rest of the app never needs to know whether a model was reachable.
 */
import type { Intel, Signal, Direction } from "@/lib/types";
import { latestIntel } from "@/lib/fixtures";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Flash-Lite by measurement, not preference: on this account gemini-3.5-flash
// spent 120 thought tokens on a trivial prompt and took 14.7s (and failed
// outright at 39.6s once), while flash-lite answered the same prompt in 3.6s
// with zero thought tokens. It also has the larger free daily quota.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
// Flash models on this API still think before answering — a trivial prompt
// measured 14.7s with 120 thought tokens. Anything under ~25s times out on a
// cold call, so the default is generous and the tick runs off-request.
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);

/**
 * The two agents call the model for different reasons and must not share a
 * quota. Intel runs on a timer and burns calls steadily; the Signal Agent runs
 * rarely but is the one that must never be unavailable, because a trade that
 * cannot be reasoned about is a trade that does not happen on camera.
 *
 * IMPORTANT: two keys only buy separate quota if they come from separate Google
 * Cloud *projects*. Gemini free-tier limits are enforced per project, so two
 * keys minted in the same project share one allowance and this split achieves
 * nothing. Check the project before trusting the isolation.
 */
export type LlmAgent = "intel" | "signal";

/**
 * Per-agent key, falling back to the shared one. The fallback is deliberate:
 * the repo works with a single GEMINI_API_KEY and splitting is an upgrade, not
 * a prerequisite.
 */
function keyFor(agent: LlmAgent): { key?: string; label: string } {
  const specific =
    agent === "intel"
      ? process.env.GEMINI_INTEL_API_KEY
      : process.env.GEMINI_SIGNAL_API_KEY;

  if (specific) return { key: specific, label: `${agent} key` };
  return { key: process.env.GEMINI_API_KEY, label: "shared key" };
}

/**
 * Which path a call will actually take, and why. Exported so callers and smoke
 * tests report the real decision instead of guessing from one env var — the
 * fixture fallback has several independent triggers and any one is easy to miss.
 *
 * Per agent, because the agents can now legitimately disagree: a missing intel
 * key must not make the console claim the Signal Agent is offline too.
 */
export function llmMode(agent: LlmAgent = "intel"): {
  mode: "fixture" | "live";
  reason: string;
} {
  if (process.env.DEMO_MODE === "fixture") {
    return { mode: "fixture", reason: "DEMO_MODE=fixture" };
  }
  const { key, label } = keyFor(agent);
  if (!key) {
    return {
      mode: "fixture",
      reason: `no key for ${agent} (set GEMINI_${agent.toUpperCase()}_API_KEY or GEMINI_API_KEY)`,
    };
  }
  return { mode: "live", reason: `gemini ${MODEL} via ${label}` };
}

/** True when the two agents are actually isolated rather than sharing one key. */
export function keysAreSplit(): boolean {
  const intel = process.env.GEMINI_INTEL_API_KEY;
  const signal = process.env.GEMINI_SIGNAL_API_KEY;
  return Boolean(intel && signal && intel !== signal);
}

/** Fixtures when explicitly asked for, and whenever there is no key to call with. */
function fixturesActive(agent: LlmAgent): boolean {
  return llmMode(agent).mode === "fixture";
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

/** One POST. Returns parsed JSON matching `schema`, or throws LlmError. */
async function generate<T>(agent: LlmAgent, input: string, schema: object): Promise<T> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": keyFor(agent).key as string,
      },
      body: JSON.stringify({
        model: MODEL,
        input,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema,
        },
      }),
    });
  } catch (err) {
    throw new LlmError(
      err instanceof Error && err.name === "TimeoutError"
        ? `model did not answer within ${TIMEOUT_MS}ms`
        : `model unreachable: ${String(err)}`,
    );
  }

  if (!res.ok) {
    throw new LlmError(`model returned ${res.status}: ${await res.text()}`, res.status);
  }

  const text = extractText(await res.json());

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`model returned unparseable JSON: ${text.slice(0, 200)}`);
  }
}

type Interaction = {
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
};

/**
 * Pull the answer out of an interaction response.
 *
 * The REST body is not the SDK's flat `output_text` — it is a `steps` array
 * where the model's reasoning arrives as a `thought` step and the answer as a
 * later `model_output` step. Read backwards and take the last real output.
 */
function extractText(body: Interaction): string {
  if (body.output_text) return body.output_text;

  const steps = body.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.type !== "model_output") continue;
    const text = (steps[i].content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");
    if (text) return text;
  }

  throw new LlmError("model returned no model_output step");
}

const DIRECTIONS: Direction[] = ["bullish", "bearish", "neutral"];

const INTEL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    assets: { type: "array", items: { type: "string" } },
    direction: { type: "string", enum: DIRECTIONS },
    confidence: { type: "number" },
  },
  required: ["summary", "assets", "direction", "confidence"],
};

const SIGNAL_SCHEMA = {
  type: "object",
  properties: {
    symbol: { type: "string" },
    side: { type: "string", enum: ["BUY", "SELL"] },
    sizeUsd: { type: "number" },
    thesis: { type: "string" },
  },
  required: ["symbol", "side", "sizeUsd", "thesis"],
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/**
 * Headline -> structured intelligence. This is the thing agents pay for, so the
 * fields have to be the ones a buyer can route straight into a strategy.
 */
export async function intelFromHeadline(args: {
  headline: string;
  sourceUrl: string;
  /** Feed description. Optional; carries the mechanism the headline omits. */
  snippet?: string;
}): Promise<Intel> {
  const now = new Date().toISOString();

  if (fixturesActive("intel")) {
    // A fresh id per call. Spreading the fixture reused intel_001 for every
    // row, which collides as a React key the moment the console renders a feed.
    return {
      ...latestIntel(),
      id: `intel_fx_${Math.random().toString(36).slice(2, 10)}`,
      headline: args.headline,
      sourceUrl: args.sourceUrl,
      createdAt: now,
    };
  }

  const out = await generate<{
    summary: string;
    assets: string[];
    direction: Direction;
    confidence: number;
  }>(
    "intel",
    [
      "You are a crypto market intelligence analyst.",
      "Read the headline and return machine-actionable intelligence for a trading agent.",
      "assets: ticker symbols only, e.g. BTC, ETH, BNB. At most 4, most affected first.",
      "direction: the likely near-term effect on those assets.",
      "confidence: 0 to 1. Be honest — most headlines are weak signals.",
      "summary: two sentences on the mechanism, not a restatement of the headline.",
      "",
      `HEADLINE: ${args.headline}`,
      args.snippet ? `EXCERPT: ${args.snippet}` : "",
      `SOURCE: ${args.sourceUrl}`,
    ].filter(Boolean).join("\n"),
    INTEL_SCHEMA,
  );

  return {
    id: `intel_${Date.now().toString(36)}`,
    headline: args.headline,
    sourceUrl: args.sourceUrl,
    summary: out.summary,
    assets: out.assets.slice(0, 4),
    direction: DIRECTIONS.includes(out.direction) ? out.direction : "neutral",
    confidence: clamp01(out.confidence),
    createdAt: now,
  };
}

/**
 * Intelligence + live prices -> a trade idea. The model proposes; it never
 * authorizes. src/lib/budget.ts decides whether this is allowed to execute.
 */
export async function signalFromIntel(args: {
  intel: Intel;
  prices: Record<string, string>;
}): Promise<Signal> {
  const now = new Date().toISOString();

  if (fixturesActive("signal")) {
    return {
      id: `signal_${Date.now().toString(36)}`,
      intelId: args.intel.id,
      symbol: "BNBUSDT",
      side: args.intel.direction === "bearish" ? "SELL" : "BUY",
      sizeUsd: 10,
      thesis: `Fixture signal derived from: ${args.intel.headline}`,
      createdAt: now,
    };
  }

  const priceLines = Object.entries(args.prices)
    .map(([symbol, price]) => `${symbol}=${price}`)
    .join(" ");

  const out = await generate<{
    symbol: string;
    side: "BUY" | "SELL";
    sizeUsd: number;
    thesis: string;
  }>(
    "signal",
    [
      "You are a trading signal engine. Combine the intelligence below with live prices",
      "and produce exactly one spot trade idea.",
      `symbol: must be one of these exact trading pairs: ${Object.keys(args.prices).join(", ")}.`,
      "sizeUsd: between 5 and 50. Scale with confidence — weak intelligence means a small size.",
      "thesis: one sentence tying the trade back to the headline.",
      "",
      `INTELLIGENCE: ${args.intel.summary}`,
      `ASSETS: ${args.intel.assets.join(", ")}`,
      `DIRECTION: ${args.intel.direction}  CONFIDENCE: ${args.intel.confidence}`,
      `LIVE PRICES: ${priceLines}`,
    ].join("\n"),
    SIGNAL_SCHEMA,
  );

  return {
    id: `signal_${Date.now().toString(36)}`,
    intelId: args.intel.id,
    symbol: out.symbol,
    side: out.side === "SELL" ? "SELL" : "BUY",
    sizeUsd: Math.min(50, Math.max(5, out.sizeUsd)),
    thesis: out.thesis,
    createdAt: now,
  };
}
