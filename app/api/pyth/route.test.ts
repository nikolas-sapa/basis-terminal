import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// ponytail: bare `node --test` cannot resolve two specifiers this route uses.
// "next/server" is behind a package export condition Node does not pick, and
// "@/*" is a tsconfig path alias Node knows nothing about. Registering a
// resolve hook reproduces exactly what Next's bundler does. It is a resolver
// only -- nothing is stubbed, the real NextResponse is exercised.
const ROOT = new URL("../../../", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(ROOT)};
      export async function resolve(spec, ctx, next) {
        if (spec === "next/server") return next("next/server.js", ctx);
        if (spec.startsWith("@/")) {
          const p = ROOT + spec.slice(2);
          return next(p.endsWith(".ts") ? p : p + ".ts", ctx);
        }
        return next(spec, ctx);
      }
    `),
  import.meta.url,
);

const ROUTE = new URL("./route.ts", import.meta.url).href;
const realFetch = globalThis.fetch;
let counter = 0;

type Result = { status: number; body: any };

/**
 * Load a FRESH copy of the route (cache-busting query) with `key` in env and
 * `fetchImpl` installed, then call GET.
 *
 * ponytail: the fresh import is load-bearing. The route memoises the feed map
 * in module scope for 10 minutes; without a new module instance per test that
 * cache leaks between tests and one of these passed for the wrong reason.
 */
async function call(fetchImpl: typeof fetch, key: string | null = "test-key"): Promise<Result> {
  if (key === null) delete process.env.PYTH_API_KEY;
  else process.env.PYTH_API_KEY = key;
  globalThis.fetch = fetchImpl;
  try {
    const mod = await import(`${ROUTE}?fresh=${counter++}`);
    const r = await mod.GET();
    return { status: r.status, body: await r.json() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const res = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const UNDER = "a".repeat(64);
const TOKEN = "b".repeat(64);
const FEEDS = [
  { id: UNDER, attributes: { symbol: "Equity.US.AAPL/USD" } },
  { id: TOKEN, attributes: { symbol: "Crypto.AAPLX/USD" } },
];
const now = () => Math.floor(Date.now() / 1000);

// Mirrors a real Hermes parsed[] entry: price/conf are strings, expo and
// publish_time are numbers, id is bare lowercase hex with no 0x prefix.
const priced = (t = now() - 5) => ({
  parsed: [
    { id: UNDER, price: { price: "33237500000", conf: "1", expo: -8, publish_time: t } },
    { id: TOKEN, price: { price: "33409200000", conf: "1", expo: -8, publish_time: t } },
  ],
});

const split = (feeds: unknown, updates: unknown) =>
  (async (u: any) =>
    String(u).includes("/v2/price_feeds") ? res(feeds) : res(updates)) as unknown as typeof fetch;

test("happy path: 200, sources.pyth true, non-zero bps, boolean marketOpen", async () => {
  const { status, body } = await call(split(FEEDS, priced()));
  assert.equal(status, 200);
  assert.equal(body.sources.pyth, true);
  assert.equal(body.pairs.length, 1);
  assert.equal(body.pairs[0].bps, 52);
  assert.notEqual(body.pairs[0].bps, 0);
  assert.equal(typeof body.pairs[0].marketOpen, "boolean");
  assert.equal(body.pairs[0].marketOpen, true);
});

test("missing key: 503 unconditionally, and no fetch is ever attempted", async () => {
  let called = false;
  const f = (async () => {
    called = true;
    return res(FEEDS);
  }) as unknown as typeof fetch;
  const { status, body } = await call(f, null);
  assert.equal(status, 503);
  assert.equal(body.pairs.length, 0);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error, /PYTH_API_KEY is not set/);
  assert.equal(called, false, "route hit the network without a key");
});

test("empty-string key is treated as missing: 503", async () => {
  const { status, body } = await call(split(FEEDS, priced()), "");
  assert.equal(status, 503);
  assert.match(body.error, /PYTH_API_KEY is not set/);
});

// A 200 carrying a JSON error object is how several APIs report rate limits.
// .json() resolves, a bare .catch never fires, and the iteration is what
// explodes -- as an opaque 500 with nothing in the log.
test("price_feeds 200 + JSON error object: 502, not a 500 from the iteration", async () => {
  const f = (async () => res({ error: "rate limited", code: 429 })) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error, /unexpected payload/);
});

test("price_feeds non-ok: 502 carrying the upstream status", async () => {
  const f = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.match(body.error, /401/);
});

// The real shape Hermes returns for an unentitled feed.
test("403 entitlement response: 502 naming the feed", async () => {
  const f = (async (u: any) =>
    String(u).includes("/v2/price_feeds")
      ? res(FEEDS)
      : new Response(
          "Not entitled: feed abc123 (no grant accepts this feed (asset type 'equity'))",
          { status: 403 },
        )) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error, /Not entitled/);
});

test("fetch itself throwing: 502, never an unhandled rejection", async () => {
  const f = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
});

test("200 with an unparseable body: 502", async () => {
  const f = (async () => res("<html>maintenance</html>")) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.match(body.error, /malformed JSON/);
});

test("updates response with no parsed[]: 502, not an empty 200", async () => {
  const { status, body } = await call(split(FEEDS, { binary: { encoding: "hex", data: [] } }));
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error, /no parsed prices/);
});

test("no symbol resolves: 502, and the price endpoint is never hit", async () => {
  let priceCalls = 0;
  const f = (async (u: any) => {
    if (!String(u).includes("/v2/price_feeds")) priceCalls++;
    return res([{ id: "c".repeat(64), attributes: { symbol: "Crypto.DOGE/USD" } }]);
  }) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.equal(body.pairs.length, 0);
  assert.equal(body.unresolved.length, 15);
  assert.equal(priceCalls, 0);
});

test("prices return but no id lines up: 502, never an empty 200", async () => {
  const { status, body } = await call(
    split(FEEDS, {
      parsed: [{ id: "f".repeat(64), price: { price: "100", conf: "1", expo: -2, publish_time: now() } }],
    }),
  );
  assert.equal(status, 502);
  assert.equal(body.pairs.length, 0);
});

test("stale underlying still returns a row, with marketOpen false", async () => {
  const { status, body } = await call(
    split(FEEDS, {
      parsed: [
        { id: UNDER, price: { price: "33237500000", conf: "1", expo: -8, publish_time: now() - 901 } },
        { id: TOKEN, price: { price: "33409200000", conf: "1", expo: -8, publish_time: now() - 5 } },
      ],
    }),
  );
  assert.equal(status, 200);
  assert.equal(body.pairs.length, 1);
  assert.equal(body.pairs[0].marketOpen, false);
});

// The product-level invariant: an empty table that looks healthy is the worst
// available outcome, so it must be unreachable.
test("INVARIANT: every response is 200-with-pairs or a loud non-200", async () => {
  const cases: Array<typeof fetch> = [
    (async () => res({ error: "rate limited" })) as unknown as typeof fetch,
    (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    (async () => new Response("Not entitled: feed abc", { status: 403 })) as unknown as typeof fetch,
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
    (async () => res("<html>")) as unknown as typeof fetch,
    (async () => res([])) as unknown as typeof fetch,
    split(FEEDS, { parsed: [] }),
    split(FEEDS, {}),
    (async () =>
      res([{ id: "c".repeat(64), attributes: { symbol: "Crypto.DOGE/USD" } }])) as unknown as typeof fetch,
    split(FEEDS, priced()),
  ];
  for (let i = 0; i < cases.length; i++) {
    const { status, body } = await call(cases[i]);
    const healthy = status === 200 && body.pairs.length > 0 && body.sources.pyth === true;
    const loud =
      status !== 200 &&
      typeof body.error === "string" &&
      body.error.length > 0 &&
      body.pairs.length === 0 &&
      body.sources.pyth === false;
    assert.ok(
      healthy || loud,
      `case ${i}: HTTP ${status} pairs=${body.pairs.length} sources=${JSON.stringify(body.sources)} error=${body.error}`,
    );
  }
});
