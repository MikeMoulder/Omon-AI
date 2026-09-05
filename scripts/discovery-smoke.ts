/**
 * Proves an agent can plug into Omon with nothing but the base URL:
 *   npm run dev
 *   npx tsx scripts/discovery-smoke.ts [baseUrl]
 *
 * This is the "unlisted but pluggable" claim, checked rather than asserted. It
 * walks the exact path a stranger's agent walks — read the well-known document,
 * find the paid endpoint, hit it unpaid, learn the price and the shape from the
 * 402 — and fails if any step would leave that agent stuck.
 */
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

type Manifest = {
  name?: string;
  description?: string;
  tags?: string[];
  disclosure?: string;
  payment?: { protocol?: string; network?: string; price?: string; payTo?: string };
  endpoints?: Array<{ path: string; url: string; status: string; returns?: unknown }>;
};

async function main() {
  console.log(`[discovery] base ${base}\n--- step 1: the well-known document ---`);

  const res = await fetch(`${base}/.well-known/x402`);
  check("/.well-known/x402 is reachable", res.ok, `http ${res.status}`);
  check("it is free — no 402 on the catalogue", res.status !== 402);
  if (!res.ok) return;

  const m = (await res.json()) as Manifest;
  console.log(JSON.stringify(m, null, 2).slice(0, 700));

  check("names the service", Boolean(m.name), m.name ?? "");
  check("describes it", Boolean(m.description));
  check("is tagged for search", (m.tags?.length ?? 0) > 0, m.tags?.join(", "));
  check("declares the payment protocol", m.payment?.protocol === "x402");
  check("declares network, price and payee",
    Boolean(m.payment?.network && m.payment?.price && m.payment?.payTo),
    `${m.payment?.price} on ${m.payment?.network}`);

  // The rails here are testnets. A buyer must not have to find that out later.
  check("discloses that the rail is not mainnet",
    Boolean(m.disclosure && /sepolia|testnet|test USDC/i.test(m.disclosure)));

  const live = (m.endpoints ?? []).filter((e) => e.status === "live");
  check("advertises at least one live endpoint", live.length > 0, `${live.length} live`);
  check("every endpoint carries an absolute url",
    (m.endpoints ?? []).every((e) => e.url?.startsWith("http")));
  check("published urls point at this host",
    (m.endpoints ?? []).every((e) => e.url.startsWith(base)),
    (m.endpoints ?? []).map((e) => e.url).join(" "));
  check("documents the response shape", live.every((e) => Boolean(e.returns)));

  console.log("\n--- step 2: follow the catalogue to a paid endpoint, unpaid ---");
  const target = live[0];
  const unpaid = await fetch(target.url);
  check("returns 402, not 401 or 404", unpaid.status === 402, `http ${unpaid.status}`);

  const challenge = unpaid.headers.get("www-authenticate") ?? "";
  const body = (await unpaid.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2).slice(0, 600));

  check("the 402 body is not empty", Object.keys(body).length > 0);
  check("names its price", Boolean(body.price));
  check("names the chain", Boolean(body.network));
  check("says how to pay", Boolean(body.howToPay));
  check("points back at the manifest", body.manifest === "/.well-known/x402");
  check("ships a redacted sample", body.preview !== null && body.preview !== undefined);

  if (body.preview && typeof body.preview === "object") {
    const p = body.preview as Record<string, unknown>;
    check("the sample withholds the paid fields",
      String(p.summary).startsWith("[paid]") && String(p.confidence).startsWith("[paid]"));
    check("the sample still shows what it is about", Boolean(p.headline && p.assets));
  }

  console.log(`\n(www-authenticate: ${challenge ? challenge.slice(0, 80) : "not set"})`);
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\n[discovery] threw:", err);
    process.exit(1);
  });
