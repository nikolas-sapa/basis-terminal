import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexJupiter,
  parseYahooChart,
  isMarketOpen,
  buildBasisPairs,
  QuoteShapeError,
  UNDER_FRESH_SEC,
  QUOTE_STALE_SEC,
  type UnderQuote,
} from "./quotes.ts";
import { MINTS, LIQUIDITY_FLOOR_USD } from "./mints.ts";

// ---------------------------------------------------------------------------
// Fixtures. Every number below is a literal captured from a real response on
// 2026-09-16, not a plausible-looking invention.
//   Jupiter: GET https://lite-api.jup.ag/tokens/v2/tag?query=verified
//   Yahoo:   GET https://query1.finance.yahoo.com/v8/finance/chart/<SYM>
//            ?interval=1d&range=1d
// ---------------------------------------------------------------------------

const AAPLX = {
  id: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  symbol: "AAPLx",
  name: "Apple xStock",
  usdPrice: 332.9810802801566,
  liquidity: 712259.3245318173,
  organicScore: 73.71625619660749,
  isVerified: true,
  decimals: 8,
};
const NVDAX = {
  id: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  symbol: "NVDAx",
  name: "NVIDIA xStock",
  usdPrice: 215.7855148596491,
  liquidity: 1874328.3211450952,
  organicScore: 82.98178991068508,
  isVerified: true,
  decimals: 8,
};
const NFLXX = {
  id: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
  symbol: "NFLXx",
  name: "Netflix xStock",
  usdPrice: 75.30231697511883,
  liquidity: 3041.049227037471,
  organicScore: 0,
  isVerified: true,
  decimals: 8,
};
const METAX = {
  id: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
  symbol: "METAx",
  name: "Meta xStock",
  usdPrice: 673.7727000741405,
  liquidity: 319132.0021305691,
  organicScore: 64.23771980010044,
  isVerified: true,
  decimals: 8,
};

// Both of these are REAL, VERIFIED, non-xStock tokens carrying the symbol
// "META" in the same payload as METAx above. They are the whole reason the
// index is keyed on mint: a symbol lookup for "META" has three candidates and
// two of them are not Meta Platforms at any price.
const METADAO = {
  id: "METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta",
  symbol: "META",
  name: "MetaDAO",
  usdPrice: 4.526802828379608,
  liquidity: 1336034.8718975543,
  organicScore: 61.564536922200766,
  isVerified: true,
  decimals: 6,
};
const META_OTHER = {
  id: "METADDFL6wWMWEoKTFJwcThTbUmtarRJZjRpzUvkxhr",
  symbol: "META",
  name: "META",
  usdPrice: 4564.199905322178,
  liquidity: 33835.29496928156,
  organicScore: 0,
  isVerified: true,
  decimals: 9,
};

const JUP_PAYLOAD = [AAPLX, NVDAX, NFLXX, METAX, METADAO, META_OTHER];

// A real AAPL chart response, trimmed to the fields this module reads.
// NOTE: `marketState` is absent from `meta` entirely, which is why nothing
// below depends on it.
const YH_AAPL = {
  chart: {
    error: null,
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "AAPL",
          exchangeName: "NMS",
          fullExchangeName: "NasdaqGS",
          instrumentType: "EQUITY",
          regularMarketTime: 1789578148,
          gmtoffset: -14400,
          timezone: "EDT",
          exchangeTimezoneName: "America/New_York",
          regularMarketPrice: 332.58,
          chartPreviousClose: 331.34,
          currentTradingPeriod: {
            pre: { timezone: "EDT", start: 1789545600, end: 1789565400, gmtoffset: -14400 },
            regular: { timezone: "EDT", start: 1789565400, end: 1789588800, gmtoffset: -14400 },
            post: { timezone: "EDT", start: 1789588800, end: 1789603200, gmtoffset: -14400 },
          },
        },
        timestamp: [1789565400],
        indicators: { quote: [{ close: [332.58] }] },
      },
    ],
  },
};

/** Wall clock at capture time: inside the 09:30-16:00 ET regular session. */
const NOW = 1789578160;
const OPEN = 1789565400;
const CLOSE = 1789588800;

const quote = (over: Partial<UnderQuote> = {}): UnderQuote => ({
  sym: "AAPL",
  px: 332.58,
  currency: "USD",
  quotedAt: 1789578148,
  sessionStart: OPEN,
  sessionEnd: CLOSE,
  fetchedAt: NOW,
  ...over,
});

const jup = indexJupiter(JUP_PAYLOAD);

// ---- Jupiter indexing -----------------------------------------------------

test("indexJupiter keys the payload by mint address", () => {
  assert.equal(jup.size, JUP_PAYLOAD.length);
  assert.equal(jup.get(AAPLX.id)?.usdPrice, 332.9810802801566);
});

// The near-miss the spec amendment is about, reproduced with real data: three
// verified tokens answer to "META" and the xStock is not the richest or the
// deepest of them. Mint is the only unambiguous key.
test("three verified tokens share the symbol META and only the mint disambiguates", () => {
  const symMatches = JUP_PAYLOAD.filter((t) => t.symbol.toUpperCase() === "METAX" || t.symbol.toUpperCase() === "META");
  assert.equal(symMatches.length, 3, "fixture no longer reproduces the collision");
  const metaMint = MINTS.find((m) => m.sym === "META")!.mint;
  assert.equal(jup.get(metaMint)?.usdPrice, 673.7727000741405);
  assert.notEqual(jup.get(metaMint)?.usdPrice, METADAO.usdPrice);
  assert.notEqual(jup.get(metaMint)?.usdPrice, META_OTHER.usdPrice);
});

test("indexJupiter throws on a payload that is not an array", () => {
  assert.throws(() => indexJupiter({ error: "rate limited" }), QuoteShapeError);
  assert.throws(() => indexJupiter(null), QuoteShapeError);
});

test("indexJupiter throws rather than returning an empty index", () => {
  assert.throws(() => indexJupiter([]), QuoteShapeError);
  assert.throws(() => indexJupiter([{ id: 1, usdPrice: "x" }]), QuoteShapeError);
});

test("indexJupiter drops entries with an unusable price instead of zeroing them", () => {
  const idx = indexJupiter([AAPLX, { ...NVDAX, usdPrice: null }, { ...NFLXX, usdPrice: 0 }]);
  assert.equal(idx.size, 1);
  assert.equal(idx.has(NVDAX.id), false);
  assert.equal(idx.has(NFLXX.id), false);
});

// ---- Yahoo parsing --------------------------------------------------------

test("parseYahooChart reads price, currency and session window from a real payload", () => {
  const q = parseYahooChart("AAPL", YH_AAPL, NOW);
  assert.equal(q.px, 332.58);
  assert.equal(q.currency, "USD");
  assert.equal(q.quotedAt, 1789578148);
  assert.equal(q.sessionStart, OPEN);
  assert.equal(q.sessionEnd, CLOSE);
  assert.equal(q.fetchedAt, NOW);
});

test("parseYahooChart throws when Yahoo reports an error or an empty result", () => {
  assert.throws(
    () => parseYahooChart("AAPL", { chart: { error: { code: "Not Found" }, result: null } }, NOW),
    QuoteShapeError,
  );
  assert.throws(() => parseYahooChart("AAPL", { chart: { result: [] } }, NOW), QuoteShapeError);
  assert.throws(() => parseYahooChart("AAPL", "Too Many Requests", NOW), QuoteShapeError);
});

// Never invent a price: a missing or zero quote must abort the symbol, not
// become a 0 that renders as a -10000 bps basis.
test("parseYahooChart throws on a missing, zero or non-numeric price", () => {
  for (const px of [undefined, null, 0, "332.58", NaN]) {
    const bad = {
      chart: {
        error: null,
        result: [{ meta: { ...YH_AAPL.chart.result[0].meta, regularMarketPrice: px } }],
      },
    };
    assert.throws(() => parseYahooChart("AAPL", bad, NOW), QuoteShapeError, `accepted ${String(px)}`);
  }
});

// Every xStock is USD-denominated. If a ticker ever resolves to a foreign
// listing, the basis against it is fiction, so refuse the quote outright.
test("parseYahooChart refuses a non-USD listing", () => {
  const eur = {
    chart: {
      error: null,
      result: [{ meta: { ...YH_AAPL.chart.result[0].meta, currency: "EUR" } }],
    },
  };
  assert.throws(() => parseYahooChart("AAPL", eur, NOW), QuoteShapeError);
});

test("parseYahooChart tolerates a missing currentTradingPeriod", () => {
  const meta = { ...YH_AAPL.chart.result[0].meta } as Record<string, unknown>;
  delete meta.currentTradingPeriod;
  const q = parseYahooChart("AAPL", { chart: { error: null, result: [{ meta }] } }, NOW);
  assert.equal(q.px, 332.58);
  assert.equal(q.sessionStart, null);
  assert.equal(q.sessionEnd, null);
});

// ---- market-open detection ------------------------------------------------

test("isMarketOpen is true inside the session window with a fresh quote", () => {
  assert.equal(isMarketOpen(quote(), NOW), true);
});

// The bug the window check exists for: one minute after the 16:00 bell the
// quote timestamp is still only seconds old, so a freshness-only rule would
// call a closed market open and present a last close as a live tick.
test("isMarketOpen is false one second past the close even with a seconds-old quote", () => {
  assert.equal(isMarketOpen(quote({ quotedAt: CLOSE }), CLOSE + 1), false);
  assert.equal(isMarketOpen(quote({ quotedAt: CLOSE }), CLOSE + 60), false);
});

test("isMarketOpen is false before the opening bell", () => {
  assert.equal(isMarketOpen(quote({ quotedAt: OPEN - 3600 }), OPEN - 1), false);
  assert.equal(isMarketOpen(quote({ quotedAt: OPEN }), OPEN), true);
});

// A market holiday: Yahoo still publishes a nominal 09:30-16:00 window, but
// nothing trades, so the last print is from the previous session.
test("isMarketOpen is false inside the window when the quote is a previous close", () => {
  assert.equal(isMarketOpen(quote({ quotedAt: OPEN - 86_400 }), OPEN + 3600), false);
  assert.equal(isMarketOpen(quote({ quotedAt: NOW - QUOTE_STALE_SEC - 1 }), NOW), false);
});

test("isMarketOpen falls back to quote freshness when no session window is given", () => {
  assert.equal(isMarketOpen(quote({ sessionStart: null, sessionEnd: null }), NOW), true);
  assert.equal(
    isMarketOpen(quote({ sessionStart: null, sessionEnd: null, quotedAt: NOW - QUOTE_STALE_SEC - 1 }), NOW),
    false,
  );
});

// ---- row assembly ---------------------------------------------------------

const under = (rows: UnderQuote[]) => new Map(rows.map((q) => [q.sym, q]));

test("a row carries both real legs, the committed mint and the derived basis", () => {
  const { pairs } = buildBasisPairs(jup, under([quote()]), NOW);
  const aapl = pairs.find((p) => p.sym === "AAPL")!;
  assert.equal(aapl.tokenSym, "AAPLx");
  assert.equal(aapl.mint, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp");
  assert.equal(aapl.tokenPx, 332.9810802801566);
  assert.equal(aapl.underPx, 332.58);
  assert.equal(aapl.bps, 12);
  assert.equal(aapl.verdict, "FAIR");
  assert.equal(aapl.marketOpen, true);
  assert.deepEqual(aapl.source, { token: "jupiter", under: "yahoo" });
});

test("every row's mint comes from the committed list, never from the payload symbol", () => {
  const { pairs } = buildBasisPairs(jup, under([quote(), quote({ sym: "META", px: 671.2 })]), NOW);
  for (const p of pairs) {
    assert.equal(p.mint, MINTS.find((m) => m.sym === p.sym)!.mint);
    assert.ok(p.mint.startsWith("Xs"), `${p.sym} mint is not an xStock mint: ${p.mint}`);
  }
});

// Defence in depth. The mint is the key, but if the token sitting at one of our
// mints ever answers to a different ticker, that is a migration or a mistake
// and the row is dropped rather than priced.
test("a mint whose token no longer carries the expected ticker is dropped, not priced", () => {
  const impostor = indexJupiter([{ ...AAPLX, symbol: "Apple", usdPrice: 0.0021 }]);
  const { pairs, unresolved } = buildBasisPairs(impostor, under([quote()]), NOW);
  assert.equal(pairs.length, 0);
  assert.ok(unresolved.some((u) => u.sym === "AAPL" && /ticker/i.test(u.reason)));
});

test("a symbol with no underlying quote is omitted and reported, never zeroed", () => {
  const { pairs, unresolved } = buildBasisPairs(jup, under([quote()]), NOW);
  assert.deepEqual(pairs.map((p) => p.sym), ["AAPL"]);
  assert.ok(unresolved.some((u) => u.sym === "NVDA" && /underlying/i.test(u.reason)));
  assert.equal(unresolved.length, MINTS.length - 1);
  for (const p of pairs) {
    assert.notEqual(p.underPx, 0);
    assert.notEqual(p.tokenPx, 0);
    assert.ok(Number.isFinite(p.underPx) && Number.isFinite(p.tokenPx));
  }
});

test("a symbol with no Jupiter entry is omitted and reported", () => {
  const { pairs, unresolved } = buildBasisPairs(
    indexJupiter([NVDAX]),
    under([quote(), quote({ sym: "NVDA", px: 215.765 })]),
    NOW,
  );
  assert.deepEqual(pairs.map((p) => p.sym), ["NVDA"]);
  assert.ok(unresolved.some((u) => u.sym === "AAPL" && /jupiter/i.test(u.reason)));
});

test("tradeable follows the liquidity floor: AAPL yes, NFLX no", () => {
  const { pairs } = buildBasisPairs(
    jup,
    under([quote(), quote({ sym: "NFLX", px: 75.19 })]),
    NOW,
  );
  const aapl = pairs.find((p) => p.sym === "AAPL")!;
  const nflx = pairs.find((p) => p.sym === "NFLX")!;
  assert.equal(aapl.tradeable, true);
  assert.equal(aapl.liquidityUsd, 712259.3245318173);
  assert.equal(nflx.tradeable, false, "NFLXx must never render a swap control");
  assert.equal(nflx.liquidityUsd, 3041.049227037471);
  assert.ok(nflx.liquidityUsd < LIQUIDITY_FLOOR_USD);
});

// The committed snapshot can only go out of date in one direction that matters.
// Live depth below the floor wins, so a drained pool loses its swap control
// without a redeploy.
test("live liquidity below the floor overrides a committed snapshot above it", () => {
  const drained = indexJupiter([{ ...AAPLX, liquidity: 4_120.5 }]);
  const [aapl] = buildBasisPairs(drained, under([quote()]), NOW).pairs;
  assert.equal(aapl.liquidityUsd, 4_120.5);
  assert.equal(aapl.tradeable, false);
  assert.equal(MINTS.find((m) => m.sym === "AAPL")!.liquidityUsd > LIQUIDITY_FLOOR_USD, true);
});

test("a missing live liquidity falls back to the committed snapshot", () => {
  const noLiq = indexJupiter([{ ...AAPLX, liquidity: null }]);
  const [aapl] = buildBasisPairs(noLiq, under([quote()]), NOW).pairs;
  assert.equal(aapl.liquidityUsd, MINTS.find((m) => m.sym === "AAPL")!.liquidityUsd);
  assert.equal(aapl.tradeable, true);
});

// Verification is not a price question, it is a "may a user send funds here"
// question, so it gates the action and never the row.
test("a token that lost its verified flag still prices but is never tradeable", () => {
  const unverified = indexJupiter([{ ...AAPLX, isVerified: false }]);
  const [aapl] = buildBasisPairs(unverified, under([quote()]), NOW).pairs;
  assert.equal(aapl.tokenPx, 332.9810802801566);
  assert.equal(aapl.tradeable, false);
});

test("rows come back sorted by absolute basis, widest first", () => {
  const { pairs } = buildBasisPairs(
    jup,
    under([
      quote(),                                      // AAPL  +12 bps
      quote({ sym: "NVDA", px: 215.765 }),          // NVDA   +1 bps
      quote({ sym: "META", px: 640.0 }),            // METAx +528 bps
    ]),
    NOW,
  );
  assert.deepEqual(pairs.map((p) => p.sym), ["META", "AAPL", "NVDA"]);
  assert.equal(pairs[0].verdict, "RICH");
  assert.equal(pairs[2].bps, 1);
});

test("an underlying older than the fresh window is labelled as cached, not as live", () => {
  const stale = quote({ fetchedAt: NOW - UNDER_FRESH_SEC - 1 });
  const [aapl] = buildBasisPairs(jup, under([stale]), NOW).pairs;
  assert.equal(aapl.source.under, "yahoo:cached");
  assert.equal(aapl.source.token, "jupiter");
});

test("marketOpen is a boolean on every row, never undefined", () => {
  const { pairs } = buildBasisPairs(jup, under([quote(), quote({ sym: "NVDA", px: 215.765 })]), NOW);
  assert.equal(pairs.length, 2);
  for (const p of pairs) assert.equal(typeof p.marketOpen, "boolean");
});
