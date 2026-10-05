import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { Pair } from "../../../lib/pairs.ts";
import { PAIRS, pythSymbol } from "../../../lib/pairs.ts";

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

type Body = {
  pairs: Pair[];
  sources: { pyth: boolean };
  unresolved: string[];
  fetchedAt: string;
  error?: string;
};
type Result = { status: number; body: Body };

/**
 * Load a FRESH copy of the route (cache-busting query) with `key` in env and
 * `fetchImpl` installed, then call GET.
 *
 * ponytail: the fresh import is load-bearing. The route memoises the feed map
 * in module scope for 10 minutes; without a new module instance per test that
 * cache leaks between tests and one of these passed for the wrong reason.
 */
async function call(fetchImpl: typeof fetch, key: string | null = "test-key"): Promise<Result> {
  return withRoute(fetchImpl, async (mod) => {
    const r = await mod.GET();
    return { status: r.status, body: await r.json() };
  }, key);
}

async function withRoute<T>(
  fetchImpl: typeof fetch,
  run: (mod: typeof import("./route.ts")) => Promise<T>,
  key: string | null = "test-key",
): Promise<T> {
  const previousKey = process.env.PYTH_API_KEY;
  if (key === null) delete process.env.PYTH_API_KEY;
  else process.env.PYTH_API_KEY = key;
  globalThis.fetch = fetchImpl;
  try {
    const mod = await import(`${ROUTE}?fresh=${counter++}`);
    return await run(mod);
  } finally {
    globalThis.fetch = realFetch;
    if (previousKey === undefined) delete process.env.PYTH_API_KEY;
    else process.env.PYTH_API_KEY = previousKey;
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
  (async (u: Parameters<typeof fetch>[0]) =>
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
  assert.match(body.error ?? "", /PYTH_API_KEY is not set/);
  assert.equal(called, false, "route hit the network without a key");
});

test("empty-string key is treated as missing: 503", async () => {
  const { status, body } = await call(split(FEEDS, priced()), "");
  assert.equal(status, 503);
  assert.match(body.error ?? "", /PYTH_API_KEY is not set/);
});

// A 200 carrying a JSON error object is how several APIs report rate limits.
// .json() resolves, a bare .catch never fires, and the iteration is what
// explodes -- as an opaque 500 with nothing in the log.
test("price_feeds 200 + JSON error object: 502, not a 500 from the iteration", async () => {
  const f = (async () => res({ error: "rate limited", code: 429 })) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error ?? "", /unexpected payload/);
});

test("price_feeds non-ok: 502 carrying the upstream status", async () => {
  const f = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.match(body.error ?? "", /401/);
});

// The real shape Hermes returns for an unentitled feed.
test("403 entitlement response: 502 naming the feed", async () => {
  const f = (async (u: Parameters<typeof fetch>[0]) =>
    String(u).includes("/v2/price_feeds")
      ? res(FEEDS)
      : new Response(
          "Not entitled: feed abc123 (no grant accepts this feed (asset type 'equity'))",
          { status: 403 },
        )) as unknown as typeof fetch;
  const { status, body } = await call(f);
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error ?? "", /Not entitled/);
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
  assert.match(body.error ?? "", /malformed JSON/);
});

test("updates response with no parsed[]: 502, not an empty 200", async () => {
  const { status, body } = await call(split(FEEDS, { binary: { encoding: "hex", data: [] } }));
  assert.equal(status, 502);
  assert.equal(body.sources.pyth, false);
  assert.match(body.error ?? "", /no parsed prices/);
});

test("no symbol resolves: 502, and the price endpoint is never hit", async () => {
  let priceCalls = 0;
  const f = (async (u: Parameters<typeof fetch>[0]) => {
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

test("eight cold and eight warm GETs share one refresh, each body remains readable", async () => {
  let metadata = 0;
  let prices = 0;
  const signals: AbortSignal[] = [];
  const f: typeof fetch = async (u, init) => {
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    if (init?.signal) signals.push(init.signal);
    await Promise.resolve();
    if (String(u).includes("/v2/price_feeds")) {
      metadata++;
      return res(FEEDS);
    }
    prices++;
    return res(priced());
  };
  await withRoute(f, async (mod) => {
    for (let round = 1; round <= 2; round++) {
      const responses = await Promise.all(Array.from({ length: 8 }, () => mod.GET()));
      assert.equal(metadata, 1, "cold metadata must be shared and cached for warm callers");
      assert.equal(prices, round, "each settled round must fetch fresh prices exactly once");
      assert.equal(new Set(responses).size, 8, "callers must receive distinct responses");
      responses[0].headers.set("x-fixture", "first-only");
      assert.equal(responses[1].headers.has("x-fixture"), false);
      const bodies: Body[] = await Promise.all(responses.map((r) => r.json()));
      assert.ok(responses.every((r) => r.status === 200));
      assert.ok(bodies.every((b) => b.sources.pyth && b.pairs.length === 1));
      bodies[0].pairs[0].sym = "changed";
      assert.equal(bodies[1].pairs[0].sym, "AAPL");
    }
    assert.equal((await mod.GET()).status, 200);
    assert.equal(metadata, 1);
    assert.equal(prices, 3, "settlement must not create a result cache TTL");
    assert.equal(signals.length, 4);
    assert.equal(signals[0], signals[1], "metadata and prices need one refresh deadline");
    assert.notEqual(signals[1], signals[2], "new refresh needs a new deadline");
  });
});

test("eight callers with all 15 pairs share one metadata fetch and two <=20-ID batches", async () => {
  const feeds = PAIRS.flatMap((p, i) => {
    const symbols = pythSymbol(p);
    return [
      { id: (i * 2 + 1).toString(16).padStart(64, "0"), attributes: { symbol: symbols.under } },
      { id: (i * 2 + 2).toString(16).padStart(64, "0"), attributes: { symbol: symbols.token } },
    ];
  });
  let metadata = 0;
  const batches: string[][] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const f: typeof fetch = async (u, init) => {
    signals.push(init?.signal);
    await Promise.resolve();
    const url = new URL(String(u));
    if (url.pathname === "/v2/price_feeds") {
      metadata++;
      return res(feeds);
    }
    assert.equal(url.searchParams.get("ignore_invalid_price_ids"), "true");
    const ids = url.searchParams.getAll("ids[]");
    batches.push(ids);
    return res({ parsed: ids.map((id) => ({
      id,
      price: { price: "10000", conf: "1", expo: -2, publish_time: now() - 5 },
    })) });
  };
  await withRoute(f, async (mod) => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => mod.GET()));
    assert.equal(metadata, 1);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map((b) => b.length), [20, 10]);
    assert.ok(batches.every((b) => b.length <= 20));
    assert.equal(new Set(signals).size, 1);
    assert.ok(signals[0] instanceof AbortSignal);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const body: Body = await response.json();
      assert.equal(body.pairs.length, 15);
      assert.equal(body.sources.pyth, true);
    }
  });
});

test("eight concurrent failures share one request and a settled retry recovers", async () => {
  let failing = true;
  let metadata = 0;
  let prices = 0;
  const f: typeof fetch = async (u) => {
    await Promise.resolve();
    if (String(u).includes("/v2/price_feeds")) {
      metadata++;
      if (failing) throw new Error("fixture unreachable");
      return res(FEEDS);
    }
    prices++;
    return res(priced());
  };
  await withRoute(f, async (mod) => {
    const failures = await Promise.all(Array.from({ length: 8 }, () => mod.GET()));
    assert.equal(metadata, 1);
    for (const response of failures) {
      const body: Body = await response.json();
      assert.equal(response.status, 502);
      assert.equal(body.sources.pyth, false);
      assert.deepEqual(body.pairs, []);
    }
    failing = false;
    const recovered = await mod.GET();
    assert.equal(recovered.status, 200);
    assert.equal(metadata, 2);
    assert.equal(prices, 1);
    assert.equal((await recovered.json()).pairs.length, 1);
  });
});

// Abort-aware transport fixtures. The fallback bounds the pre-fix RED run,
// where no signal is passed; production fetch/body reads use the same signal.
const hangUntilAbort = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_, reject) => {
    const fallback = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("fixture received no effective abort"));
    }, 250);
    const abort = () => {
      clearTimeout(fallback);
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

for (const phase of ["metadata headers", "metadata body", "price headers", "price body", "error body"]) {
  test(`whole-refresh 20000ms deadline bounds ${phase} and permits recovery`, async (t) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const budgets: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      budgets.push(ms);
      return timeout(25);
    });
    let failing = true;
    const signals: Array<AbortSignal | null | undefined> = [];
    const f: typeof fetch = async (u, init) => {
      signals.push(init?.signal);
      const metadata = String(u).includes("/v2/price_feeds");
      const relevant = phase.startsWith("metadata") ? metadata : !metadata;
      if (failing && relevant) {
        if (phase.endsWith("headers")) return hangUntilAbort(init?.signal);
        const response = phase === "error body" ? res("upstream error", { status: 503 }) : res({});
        Object.defineProperty(response, phase === "error body" ? "text" : "json", {
          value: () => hangUntilAbort(init?.signal),
        });
        return response;
      }
      return res(metadata ? FEEDS : priced());
    };
    await withRoute(f, async (mod) => {
      const start = performance.now();
      const failed = await mod.GET();
      assert.ok(performance.now() - start < 1000, "abort-aware hang must settle in <1 second");
      assert.equal(failed.status, 502);
      const body: Body = await failed.json();
      assert.equal(body.sources.pyth, false);
      assert.deepEqual(body.pairs, []);
      assert.deepEqual(budgets, [20_000]);
      assert.equal(new Set(signals).size, 1, "all refresh calls share the deadline");
      assert.ok(signals[0]?.aborted);
      failing = false;
      const recovered = await mod.GET();
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).pairs.length, 1);
      assert.deepEqual(budgets, [20_000, 20_000]);
    });
  });
}
