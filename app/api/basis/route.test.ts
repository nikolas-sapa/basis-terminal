import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { MINTS } from "../../../lib/mints.ts";
import type { BasisPair, MarketStatus, Unresolved } from "../../../lib/quotes.ts";

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

/** A value that must never reach the client. */
const TEST_KEY = "finnhub-test-key-must-never-be-serialised";

/** The contract the UI is built against, asserted by being the parsed type. */
type Body = {
  pairs: BasisPair[];
  sources: { jupiter: boolean; finnhub: boolean; yahoo: boolean };
  unresolved: Unresolved[];
  degraded: string[];
  marketStatus: MarketStatus | null;
  fetchedAt: string;
  error?: string;
};

type Result = { status: number; body: Body };

/**
 * Load a FRESH copy of the route (cache-busting query) with `key` in env and
 * `fetchImpl` installed, then call GET.
 *
 * ponytail: the fresh import is load-bearing twice over. The route memoises
 * the Jupiter index, every underlying quote, the market status, the Finnhub
 * round clock and both cooldowns in module scope. Without a new module
 * instance per test that state leaks and a test passes for the wrong reason.
 * It is also what makes the unconfigured path testable at all: FINNHUB_API_KEY
 * is read at module scope, exactly as PYTH_API_KEY is in /api/pyth.
 */
async function call(fetchImpl: typeof fetch, key: string | null = TEST_KEY): Promise<Result> {
  if (key === null) delete process.env.FINNHUB_API_KEY;
  else process.env.FINNHUB_API_KEY = key;
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

// ---------------------------------------------------------------------------
// Fixtures. Literals captured from live 200s on 2026-09-16, mid-session.
//   Jupiter GET https://lite-api.jup.ag/tokens/v2/tag?query=verified
//   Finnhub GET https://finnhub.io/api/v1/quote?symbol=<SYM>
//   Finnhub GET https://finnhub.io/api/v1/stock/market-status?exchange=US
//   Yahoo   GET https://query1.finance.yahoo.com/v8/finance/chart/<SYM>
// ---------------------------------------------------------------------------

const JUP = [
  {
    id: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    symbol: "AAPLx",
    name: "Apple xStock",
    usdPrice: 332.9810802801566,
    liquidity: 712259.3245318173,
    isVerified: true,
  },
  {
    id: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    usdPrice: 215.7855148596491,
    liquidity: 1874328.3211450952,
    isVerified: true,
  },
  {
    id: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    symbol: "METAx",
    name: "Meta xStock",
    usdPrice: 673.7727000741405,
    liquidity: 319132.0021305691,
    isVerified: true,
  },
];

/**
 * Real Finnhub quotes for the whole allowlist, captured in one pass. All 15
 * are covered on the free tier, ETFs included (SPY, QQQ, GLD).
 */
const FH: Record<string, unknown> = {
  SPY: { c: 759.58, d: 2.19, dp: 0.2892, h: 761.67, l: 758.723, o: 759.195, pc: 757.39, t: 1789580577 },
  NVDA: { c: 214.97, d: 2.8, dp: 1.3197, h: 216.76, l: 213.31, o: 213.945, pc: 212.17, t: 1789580600 },
  QQQ: { c: 709.32, d: 4.78, dp: 0.6785, h: 711.88, l: 707.64, o: 707.77, pc: 704.54, t: 1789581206 },
  CRCL: { c: 81.55, d: -4.75, dp: -5.5041, h: 85.96, l: 79.15, o: 85.3375, pc: 86.3, t: 1789581198 },
  TSLA: { c: 360.55, d: 3.97, dp: 1.1134, h: 365.1, l: 354.8913, o: 357.8125, pc: 356.58, t: 1789581206 },
  HOOD: { c: 105.1, d: -5.35, dp: -4.8438, h: 111.05, l: 104.44, o: 110.045, pc: 110.45, t: 1789581206 },
  AAPL: { c: 333.27, d: 1.93, dp: 0.5825, h: 335.48, l: 331.87, o: 331.96, pc: 331.34, t: 1789580577 },
  MSTR: { c: 125.9, d: -3.7, dp: -2.8549, h: 130.42, l: 125.26, o: 129.335, pc: 129.6, t: 1789581206 },
  GLD: { c: 398.64, d: 4.49, dp: 1.1392, h: 399.94, l: 396.4, o: 397.92, pc: 394.15, t: 1789581205 },
  MSFT: { c: 493.48, d: -3.64, dp: -0.7322, h: 495.97, l: 491.13, o: 494.865, pc: 497.12, t: 1789581205 },
  GOOGL: { c: 344.77, d: -0.21, dp: -0.0609, h: 348.4, l: 343.75, o: 346.105, pc: 344.98, t: 1789581205 },
  META: { c: 675.18, d: 4.94, dp: 0.737, h: 685.31, l: 674.2901, o: 676.0425, pc: 670.24, t: 1789580599 },
  COIN: { c: 165.14, d: -6.97, dp: -4.0497, h: 174, l: 164.58, o: 171.96, pc: 172.11, t: 1789581206 },
  AMZN: { c: 247.79, d: -0.63, dp: -0.2536, h: 249.26, l: 246.69, o: 248.305, pc: 248.42, t: 1789581206 },
  NFLX: { c: 77.11, d: -0.79, dp: -1.0141, h: 77.81, l: 77.0633, o: 77.7175, pc: 77.9, t: 1789581205 },
};

/**
 * The real body for a symbol Finnhub will not price: HTTP 200, every field
 * zeroed, `d`/`dp` null rather than 0. Captured from `?symbol=ZZZZFAKE`.
 */
const FH_ZERO = { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 };

const FH_STATUS = {
  exchange: "US",
  holiday: null,
  isOpen: true,
  session: "regular",
  t: 1789580601,
  timezone: "America/New_York",
};

/** A real Yahoo chart response, trimmed to the fields the parser reads. */
const yh = (sym: string, px: number) => ({
  chart: {
    error: null,
    result: [
      {
        meta: {
          currency: "USD",
          symbol: sym,
          regularMarketPrice: px,
          regularMarketTime: Math.floor(Date.now() / 1000) - 5,
          currentTradingPeriod: {
            regular: {
              start: Math.floor(Date.now() / 1000) - 3600,
              end: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        },
      },
    ],
  },
});

/**
 * The captured quotes carry their real capture timestamps, and freshness is
 * judged against the wall clock. Only `t` is re-stamped; every price stays the
 * frozen literal it was captured as. Without this a fixture silently decays
 * into a "market closed" assertion an hour after capture.
 */
const stamped = (q: unknown) => ({ ...(q as object), t: Math.floor(Date.now() / 1000) - 5 });

const header = (init?: RequestInit) =>
  (init?.headers as Record<string, string> | undefined)?.["X-Finnhub-Token"];

const symOf = (u: unknown) => new URL(String(u)).searchParams.get("symbol") ?? "";
const yahooSym = (u: unknown) => String(u).split("/chart/")[1]?.split("?")[0] ?? "";

type Counts = { jupiter: number; quote: number; status: number; yahoo: number };

/**
 * A stub upstream. `over` replaces any leg with a canned Response, which is
 * how the failure cases are built.
 */
function upstream(over: Partial<Record<keyof Counts, () => Response>> = {}) {
  const counts: Counts = { jupiter: 0, quote: 0, status: 0, yahoo: 0 };
  const fetchImpl = (async (u: string | URL) => {
    const url = String(u);
    if (url.includes("lite-api.jup.ag")) {
      counts.jupiter++;
      return over.jupiter ? over.jupiter() : res(JUP);
    }
    if (url.includes("/stock/market-status")) {
      counts.status++;
      return over.status ? over.status() : res(FH_STATUS);
    }
    if (url.includes("finnhub.io")) {
      counts.quote++;
      const q = FH[symOf(url)];
      return over.quote ? over.quote() : res(q ? stamped(q) : FH_ZERO);
    }
    if (url.includes("query1.finance.yahoo.com")) {
      counts.yahoo++;
      return over.yahoo ? over.yahoo() : res(yh(yahooSym(url), 331.1));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, counts };
}

const err = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// ---- happy path -----------------------------------------------------------

test("happy path: Finnhub prices the table, Yahoo is never touched", async () => {
  const { fetchImpl, counts } = upstream();
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 200);
  assert.equal(body.sources.jupiter, true);
  assert.equal(body.sources.finnhub, true);
  assert.equal(body.sources.yahoo, false);
  assert.equal(counts.yahoo, 0, "Yahoo was hit while Finnhub was healthy");
  assert.equal(body.pairs.length, 3);
  for (const p of body.pairs) {
    assert.equal(p.source.under, "finnhub");
    assert.equal(p.source.token, "jupiter");
  }
  const aapl = body.pairs.find((p) => p.sym === "AAPL")!;
  assert.equal(aapl.underPx, 333.27);
  assert.equal(aapl.tokenPx, 332.9810802801566);
  assert.equal(aapl.mint, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp");
  assert.equal(typeof aapl.bps, "number");
  assert.equal(typeof aapl.verdict, "string");
});

test("the response contract keeps every field the UI reads", async () => {
  const { fetchImpl } = upstream();
  const { body } = await call(fetchImpl);
  for (const k of ["pairs", "sources", "unresolved", "fetchedAt"]) {
    assert.ok(k in body, `missing top-level ${k}`);
  }
  assert.ok("jupiter" in body.sources && "finnhub" in body.sources);
  for (const k of [
    "sym", "tokenSym", "mint", "tokenPx", "underPx",
    "bps", "verdict", "marketOpen", "liquidityUsd", "tradeable", "source",
  ]) {
    assert.ok(k in body.pairs[0], `missing pair field ${k}`);
  }
  assert.equal(new Date(body.fetchedAt).toString() === "Invalid Date", false);
});

test("the exchange's own session state reaches the rows", async () => {
  const { fetchImpl, counts } = upstream();
  const { body } = await call(fetchImpl);
  assert.equal(counts.status, 1);
  assert.equal(body.marketStatus!.isOpen, true);
  assert.equal(body.marketStatus!.session, "regular");
  for (const p of body.pairs) assert.equal(p.marketOpen, true);
});

// The key is a header, never a query parameter, and nothing serialises it.
test("the API key never appears in a URL or in the response body", async () => {
  const seen: string[] = [];
  const f = (async (u: string | URL, init?: RequestInit) => {
    seen.push(String(u));
    const url = String(u);
    if (url.includes("lite-api.jup.ag")) return res(JUP);
    if (url.includes("/stock/market-status")) {
      assert.equal(header(init), TEST_KEY);
      return res(FH_STATUS);
    }
    if (url.includes("finnhub.io")) {
      assert.equal(header(init), TEST_KEY);
      return res(stamped(FH[symOf(url)]));
    }
    return res(yh(yahooSym(url), 331.1));
  }) as unknown as typeof fetch;

  const { body } = await call(f);
  for (const u of seen) assert.ok(!u.includes(TEST_KEY), `key leaked into a URL: ${u}`);
  assert.ok(!JSON.stringify(body).includes(TEST_KEY), "key leaked into the response body");
});

// ---- the budget -----------------------------------------------------------

test("15 symbols per round, and a second poll inside the window spends nothing", async () => {
  const { fetchImpl, counts } = upstream();
  process.env.FINNHUB_API_KEY = TEST_KEY;
  globalThis.fetch = fetchImpl;
  try {
    const mod = await import(`${ROUTE}?fresh=${counter++}`);
    await mod.GET();
    assert.equal(counts.quote, MINTS.length, "first round should price every symbol once");
    assert.equal(counts.status, 1);

    await mod.GET();
    assert.equal(counts.quote, MINTS.length, "a second poll re-fetched inside the round window");
    assert.equal(counts.status, 1, "market status re-fetched inside its TTL");
    assert.equal(counts.jupiter, 1, "the 5MB token list was re-fetched");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The failure mode a per-symbol age test would have: while the upstream is
// broken every symbol stays stale, so every poll fires a fresh full round and
// burns the minute's quota in seconds.
test("a failing Finnhub leg does not re-fire a round on the next poll", async () => {
  const { fetchImpl, counts } = upstream({ quote: () => err(500, "upstream error") });
  process.env.FINNHUB_API_KEY = TEST_KEY;
  globalThis.fetch = fetchImpl;
  try {
    const mod = await import(`${ROUTE}?fresh=${counter++}`);
    await mod.GET();
    const afterFirst = counts.quote;
    await mod.GET();
    await mod.GET();
    assert.equal(counts.quote, afterFirst, "a broken upstream was polled again immediately");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the unconfigured path ------------------------------------------------

test("no key: Finnhub is never called and the fallback carries the table", async () => {
  const { fetchImpl, counts } = upstream();
  const { status, body } = await call(fetchImpl, null);
  assert.equal(counts.quote, 0, "route hit Finnhub without a key");
  assert.equal(counts.status, 0);
  assert.equal(status, 200);
  assert.equal(body.sources.finnhub, false);
  assert.equal(body.sources.yahoo, true);
  assert.ok(body.pairs.length > 0);
  for (const p of body.pairs) assert.equal(p.source.under, "yahoo");
  assert.ok(
    body.degraded.some((d: string) => d.includes("FINNHUB_API_KEY")),
    "a 200 served off the fallback must still name the missing variable",
  );
});

test("no key and no fallback: 503 naming FINNHUB_API_KEY and where to get one", async () => {
  const { fetchImpl } = upstream({ yahoo: () => err(429, "Too Many Requests") });
  const { status, body } = await call(fetchImpl, null);
  assert.equal(status, 503);
  assert.equal(body.pairs.length, 0);
  assert.equal(body.sources.finnhub, false);
  assert.match(body.error!, /FINNHUB_API_KEY is not set/);
  assert.match(body.error!, /finnhub\.io\/register/);
  assert.equal(body.unresolved.length, MINTS.length);
});

test("empty-string key is treated as missing", async () => {
  const { fetchImpl, counts } = upstream({ yahoo: () => err(429, "Too Many Requests") });
  const { status, body } = await call(fetchImpl, "");
  assert.equal(counts.quote, 0);
  assert.equal(status, 503);
  assert.match(body.error!, /FINNHUB_API_KEY is not set/);
});

// ---- Finnhub failing, Yahoo catching --------------------------------------

test("a rejected key falls back to Yahoo rather than emptying the table", async () => {
  const { fetchImpl, counts } = upstream({
    quote: () => err(401, { error: "Invalid API key." }),
    status: () => err(401, { error: "Invalid API key." }),
  });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 200);
  assert.equal(body.sources.finnhub, false);
  assert.equal(body.sources.yahoo, true);
  assert.ok(counts.yahoo > 0, "the fallback never ran");
  assert.ok(body.pairs.length > 0);
  for (const p of body.pairs) assert.equal(p.source.under, "yahoo");
  assert.ok(body.degraded.some((d: string) => d.includes("401")), body.degraded.join(" | "));
  assert.equal(body.marketStatus, null);
});

test("a 429 backs the Finnhub leg off and says so", async () => {
  const { fetchImpl } = upstream({
    quote: () => err(429, { error: "API limit reached." }),
  });
  const { body } = await call(fetchImpl);
  assert.equal(body.sources.finnhub, false);
  assert.ok(
    body.degraded.some((d: string) => /backing off/.test(d)),
    body.degraded.join(" | "),
  );
});

// An open exchange is not a live number. These are the captured quotes with
// their real capture timestamps left alone, which by now are hours old.
test("a print older than the stale window is not drawn as live, open exchange or not", async () => {
  const { fetchImpl } = upstream({ quote: () => res(FH.AAPL) });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 200);
  assert.equal(body.marketStatus!.isOpen, true);
  assert.ok(body.pairs.length > 0);
  for (const p of body.pairs) {
    if (p.source.under.startsWith("finnhub")) {
      assert.equal(p.marketOpen, false, `${p.sym} drew an aged print as a live tick`);
    }
  }
});

test("market-status failing is not fatal: rows still price, marketStatus is null", async () => {
  const { fetchImpl } = upstream({ status: () => err(500, "boom") });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 200);
  assert.equal(body.marketStatus, null);
  assert.equal(body.sources.finnhub, true);
  assert.equal(body.pairs.length, 3);
  // Degraded to per-quote freshness, which for these captures is a stale one.
  for (const p of body.pairs) assert.equal(typeof p.marketOpen, "boolean");
  assert.ok(body.degraded.some((d: string) => d.startsWith("market-status:")));
});

// ---- fail loud ------------------------------------------------------------

// The single worst response this route could give: HTTP 200, a clean empty
// table, and a dead upstream that reads as a quiet market.
test("both underlying legs down: 502, never an empty 200", async () => {
  const { fetchImpl } = upstream({
    quote: () => err(500, "boom"),
    yahoo: () => err(429, "Too Many Requests"),
  });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 502);
  assert.equal(body.pairs.length, 0);
  assert.equal(body.sources.finnhub, false);
  assert.equal(body.sources.yahoo, false);
  assert.ok(body.error!.length > 0);
  assert.equal(body.unresolved.length, MINTS.length);
});

// The zero trap end to end: Finnhub answers 200 for every symbol with a body
// full of zeros. Not one of them may become a row.
test("an all-zero Finnhub table produces no rows, not rows priced at zero", async () => {
  const { fetchImpl } = upstream({
    quote: () => res(FH_ZERO),
    yahoo: () => err(429, "Too Many Requests"),
  });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 502);
  assert.equal(body.pairs.length, 0);
  assert.ok(/all-zero|unknown/i.test(JSON.stringify(body.degraded)), JSON.stringify(body.degraded));
});

test("no row ever carries a zero or non-finite price", async () => {
  for (const over of [{}, { quote: () => res(FH_ZERO) }, { status: () => err(500, "boom") }]) {
    const { fetchImpl } = upstream(over);
    const { body } = await call(fetchImpl);
    for (const p of body.pairs) {
      assert.ok(Number.isFinite(p.underPx) && p.underPx > 0, `${p.sym} underPx ${p.underPx}`);
      assert.ok(Number.isFinite(p.tokenPx) && p.tokenPx > 0, `${p.sym} tokenPx ${p.tokenPx}`);
    }
  }
});

test("Jupiter down: 502 with every source false, and no price leg is attempted", async () => {
  const { fetchImpl, counts } = upstream({ jupiter: () => err(503, "unavailable") });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 502);
  assert.equal(body.pairs.length, 0);
  assert.deepEqual(body.sources, { jupiter: false, finnhub: false, yahoo: false });
  assert.equal(counts.quote, 0);
  assert.equal(counts.yahoo, 0);
  assert.equal(body.unresolved.length, MINTS.length);
});

test("Jupiter 200 carrying a JSON error object: 502, not a 500 from the iteration", async () => {
  const { fetchImpl } = upstream({ jupiter: () => res({ error: "rate limited" }) });
  const { status, body } = await call(fetchImpl);
  assert.equal(status, 502);
  assert.match(body.error!, /expected an array|unexpected shape/);
});

test("a symbol the underlying leg cannot price is named in unresolved, not shipped", async () => {
  const { fetchImpl } = upstream({ yahoo: () => err(429, "Too Many Requests") });
  const { body } = await call(fetchImpl);
  const priced = new Set(body.pairs.map((p) => p.sym));
  const named = new Set(body.unresolved.map((u) => u.sym));
  assert.equal(priced.size + named.size, MINTS.length);
  for (const m of MINTS) assert.ok(priced.has(m.sym) || named.has(m.sym), `${m.sym} vanished`);
  for (const u of body.unresolved) assert.ok(u.reason.length > 0, `${u.sym} has no reason`);
});

// The product-level invariant, same one /api/pyth holds.
test("INVARIANT: every response is 200-with-pairs or a loud non-200", async () => {
  const cases: Array<[string, Parameters<typeof upstream>[0], string | null]> = [
    ["healthy", {}, TEST_KEY],
    ["no key, fallback alive", {}, null],
    ["no key, fallback dead", { yahoo: () => err(429, "x") }, null],
    ["finnhub 401", { quote: () => err(401, { error: "Invalid API key." }) }, TEST_KEY],
    ["finnhub 429", { quote: () => err(429, { error: "API limit reached." }) }, TEST_KEY],
    ["finnhub zeros", { quote: () => res(FH_ZERO) }, TEST_KEY],
    ["finnhub html", { quote: () => res("<html>maintenance</html>") }, TEST_KEY],
    ["both legs dead", { quote: () => err(500, "x"), yahoo: () => err(429, "x") }, TEST_KEY],
    ["jupiter dead", { jupiter: () => err(503, "x") }, TEST_KEY],
    ["jupiter empty array", { jupiter: () => res([]) }, TEST_KEY],
    ["everything throws", {
      jupiter: () => { throw new Error("ECONNREFUSED"); },
      quote: () => { throw new Error("ECONNREFUSED"); },
      yahoo: () => { throw new Error("ECONNREFUSED"); },
      status: () => { throw new Error("ECONNREFUSED"); },
    }, TEST_KEY],
  ];

  for (const [name, over, key] of cases) {
    const { fetchImpl } = upstream(over);
    const { status, body } = await call(fetchImpl, key);
    const healthy = status === 200 && body.pairs.length > 0;
    const loud =
      status !== 200 &&
      typeof body.error === "string" &&
      body.error.length > 0 &&
      body.pairs.length === 0 &&
      body.sources.finnhub === false;
    assert.ok(
      healthy || loud,
      `${name}: HTTP ${status} pairs=${body.pairs.length} sources=${JSON.stringify(body.sources)} error=${body.error}`,
    );
  }
});
