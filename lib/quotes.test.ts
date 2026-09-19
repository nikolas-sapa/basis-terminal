import { test } from "node:test";
import assert from "node:assert/strict";
import { bps } from "./basis.ts";
import {
  indexJupiter,
  parseFinnhubQuote,
  parseMarketStatus,
  parseYahooChart,
  isMarketOpen,
  buildBasisPairs,
  QuoteShapeError,
  UNDER_FRESH_SEC,
  QUOTE_STALE_SEC,
  type MarketStatus,
  type UnderQuote,
  parseJupPrices,
  overlayPrices,
  type JupToken,
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

// ---------------------------------------------------------------------------
// Finnhub fixtures. Every one of these is a literal captured from a live 200
// on 2026-09-16 at roughly 13:43 ET, mid-session, with a real key:
//   GET https://finnhub.io/api/v1/quote?symbol=<SYM>
//   GET https://finnhub.io/api/v1/stock/market-status?exchange=US
// Nothing here is reconstructed from the docs.
// ---------------------------------------------------------------------------

const FH_AAPL = { c: 333.27, d: 1.93, dp: 0.5825, h: 335.48, l: 331.87, o: 331.96, pc: 331.34, t: 1789580577 };
const FH_NVDA = { c: 214.97, d: 2.8, dp: 1.3197, h: 216.76, l: 213.31, o: 213.945, pc: 212.17, t: 1789580600 };
const FH_META = { c: 675.18, d: 4.94, dp: 0.737, h: 685.31, l: 674.2901, o: 676.0425, pc: 670.24, t: 1789580599 };
/** SPY, to prove the free tier covers ETFs and not just single names. */
const FH_SPY = { c: 759.58, d: 2.19, dp: 0.2892, h: 761.67, l: 758.723, o: 759.195, pc: 757.39, t: 1789580577 };

/**
 * The trap. A symbol Finnhub does not cover answers HTTP 200, not 404, with
 * every price field zeroed and the change fields null. Captured from
 * `?symbol=ZZZZFAKE`.
 */
const FH_UNKNOWN = { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 };

/** Real 401 bodies, captured keyless and with a junk token. */
const FH_NO_KEY = { error: "Please use an API key." };
const FH_BAD_KEY = { error: "Invalid API key." };

const FH_STATUS_OPEN = {
  exchange: "US",
  holiday: null,
  isOpen: true,
  session: "regular",
  t: 1789580601,
  timezone: "America/New_York",
};

/**
 * Finnhub's own published sample for the same endpoint. Not captured live (the
 * market was open), but it is the documented other side of the flag and the
 * reason `isOpen` is trusted: it is already false during pre-market.
 */
const FH_STATUS_PRE = {
  exchange: "US",
  holiday: null,
  isOpen: false,
  session: "pre-market",
  t: 1697018041,
  timezone: "America/New_York",
};

/** A few seconds after the quotes above were captured. */
const FH_NOW = 1789580610;

const quote = (over: Partial<UnderQuote> = {}): UnderQuote => ({
  sym: "AAPL",
  px: 332.58,
  currency: "USD",
  quotedAt: 1789578148,
  sessionStart: OPEN,
  sessionEnd: CLOSE,
  fetchedAt: NOW,
  provider: "yahoo",
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

// ---- Finnhub parsing ------------------------------------------------------

test("parseFinnhubQuote reads the price and the last-trade time from a real payload", () => {
  const q = parseFinnhubQuote("AAPL", FH_AAPL, FH_NOW);
  assert.equal(q.px, 333.27);
  assert.equal(q.quotedAt, 1789580577);
  assert.equal(q.fetchedAt, FH_NOW);
  assert.equal(q.provider, "finnhub");
  // The payload states no currency and carries no session window. Claiming
  // either would be inventing data; market-status supplies the session.
  assert.equal(q.currency, null);
  assert.equal(q.sessionStart, null);
  assert.equal(q.sessionEnd, null);
});

test("parseFinnhubQuote covers ETFs, not just single names", () => {
  assert.equal(parseFinnhubQuote("SPY", FH_SPY, FH_NOW).px, 759.58);
});

// The single most dangerous response in this integration: a symbol Finnhub
// does not cover returns HTTP 200 with a zeroed body rather than a 404. Read
// as a price it puts a $0 underlying on screen and a -10000 bps basis beside
// it. It must abort the symbol.
test("parseFinnhubQuote throws on the all-zero body of an uncovered symbol", () => {
  assert.throws(
    () => parseFinnhubQuote("ZZZZFAKE", FH_UNKNOWN, FH_NOW),
    (e: unknown) => e instanceof QuoteShapeError && /all-zero|unknown/i.test(e.message),
  );
});

test("parseFinnhubQuote throws on a missing, negative or non-numeric price", () => {
  for (const c of [undefined, null, -1, "333.27", NaN]) {
    assert.throws(
      () => parseFinnhubQuote("AAPL", { ...FH_AAPL, c }, FH_NOW),
      QuoteShapeError,
      `accepted c=${String(c)}`,
    );
  }
});

// A 200 carrying an error object is how several APIs report a throttle, and
// these two bodies are the real ones Finnhub sends today (with a 401).
test("parseFinnhubQuote refuses a payload carrying an error string", () => {
  assert.throws(() => parseFinnhubQuote("AAPL", FH_NO_KEY, FH_NOW), QuoteShapeError);
  assert.throws(() => parseFinnhubQuote("AAPL", FH_BAD_KEY, FH_NOW), QuoteShapeError);
});

test("parseFinnhubQuote refuses anything that is not an object", () => {
  for (const p of [null, undefined, "Too Many Requests", [FH_AAPL], 42]) {
    assert.throws(() => parseFinnhubQuote("AAPL", p, FH_NOW), QuoteShapeError, `accepted ${String(p)}`);
  }
});

// A missing timestamp costs the row its live/stale label, not its price.
test("parseFinnhubQuote keeps a good price when the timestamp is absent or zero", () => {
  const noT = parseFinnhubQuote("AAPL", { ...FH_AAPL, t: undefined }, FH_NOW);
  assert.equal(noT.px, 333.27);
  assert.equal(noT.quotedAt, null);
  assert.equal(parseFinnhubQuote("AAPL", { ...FH_AAPL, t: 0 }, FH_NOW).quotedAt, null);
});

// ---- Finnhub market status ------------------------------------------------

test("parseMarketStatus reads the live mid-session payload", () => {
  const s = parseMarketStatus(FH_STATUS_OPEN);
  assert.equal(s.isOpen, true);
  assert.equal(s.session, "regular");
  assert.equal(s.exchange, "US");
  assert.equal(s.holiday, null);
  assert.equal(s.t, 1789580601);
});

// The reason the flag is trusted at all: Finnhub already reports pre-market as
// closed, so `isOpen` tracks the regular session and not an extended one.
test("parseMarketStatus reports pre-market as closed", () => {
  const s = parseMarketStatus(FH_STATUS_PRE);
  assert.equal(s.isOpen, false);
  assert.equal(s.session, "pre-market");
});

test("parseMarketStatus carries a holiday name through", () => {
  const s = parseMarketStatus({ ...FH_STATUS_OPEN, isOpen: false, session: null, holiday: "Christmas" });
  assert.equal(s.holiday, "Christmas");
  assert.equal(s.session, null);
});

// Guessing an isOpen would put a "market open" badge on a Sunday.
test("parseMarketStatus throws rather than guessing a missing isOpen", () => {
  const noFlag = { ...FH_STATUS_OPEN } as Record<string, unknown>;
  delete noFlag.isOpen;
  assert.throws(() => parseMarketStatus(noFlag), QuoteShapeError);
  assert.throws(() => parseMarketStatus({ ...FH_STATUS_OPEN, isOpen: "true" }), QuoteShapeError);
  assert.throws(() => parseMarketStatus(FH_NO_KEY), QuoteShapeError);
  assert.throws(() => parseMarketStatus(null), QuoteShapeError);
  assert.throws(() => parseMarketStatus([FH_STATUS_OPEN]), QuoteShapeError);
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

// ---- market-open detection, with Finnhub's authoritative status -----------

/** A real Finnhub quote, parsed. Carries no session window of its own. */
const fh = (payload: unknown = FH_AAPL, sym = "AAPL", over: Partial<UnderQuote> = {}): UnderQuote => ({
  ...parseFinnhubQuote(sym, payload, FH_NOW),
  ...over,
});
const OPEN_STATUS: MarketStatus = parseMarketStatus(FH_STATUS_OPEN);
const PRE_STATUS: MarketStatus = parseMarketStatus(FH_STATUS_PRE);

test("a Finnhub quote has no window of its own, so the exchange's status supplies one", () => {
  const q = fh();
  assert.equal(q.sessionStart, null);
  assert.equal(isMarketOpen(q, FH_NOW, OPEN_STATUS), true);
});

// The case clock arithmetic gets wrong and the exchange does not: seconds
// after the bell the last print is still fresh, but nothing is trading.
test("isMarketOpen is false when the exchange says closed, however fresh the quote", () => {
  assert.equal(isMarketOpen(fh(), FH_NOW, PRE_STATUS), false);
  assert.equal(
    isMarketOpen(fh(), FH_NOW, { ...OPEN_STATUS, isOpen: false, session: null, holiday: "Christmas" }),
    false,
  );
});

// If the flag and the session label ever disagree, fail towards "closed".
test("isMarketOpen refuses an extended session even when isOpen contradicts it", () => {
  assert.equal(isMarketOpen(fh(), FH_NOW, { ...OPEN_STATUS, session: "pre-market" }), false);
  assert.equal(isMarketOpen(fh(), FH_NOW, { ...OPEN_STATUS, session: "post-market" }), false);
  assert.equal(isMarketOpen(fh(), FH_NOW, { ...OPEN_STATUS, session: null }), false);
});

// An open exchange is not a live number. A row whose last print is 20 minutes
// old is a stale number and must not be drawn as a tick.
test("isMarketOpen still requires a fresh quote while the exchange is open", () => {
  assert.equal(isMarketOpen(fh(FH_AAPL, "AAPL", { quotedAt: FH_NOW - QUOTE_STALE_SEC }), FH_NOW, OPEN_STATUS), false);
  assert.equal(isMarketOpen(fh(FH_AAPL, "AAPL", { quotedAt: null }), FH_NOW, OPEN_STATUS), false);
});

// The status endpoint is an enhancement, not a dependency: without it a
// Finnhub row degrades to freshness only rather than disappearing.
test("isMarketOpen degrades to freshness for a Finnhub quote when the status is missing", () => {
  assert.equal(isMarketOpen(fh(), FH_NOW, null), true);
  assert.equal(isMarketOpen(fh(FH_AAPL, "AAPL", { quotedAt: FH_NOW - QUOTE_STALE_SEC }), FH_NOW, null), false);
});

// A half-day close: Yahoo keeps publishing a nominal 09:30-16:00 window, the
// exchange knows better. The exchange wins.
test("the exchange's status overrides Yahoo's published window", () => {
  const inWindow = quote({ quotedAt: OPEN + 3600, fetchedAt: OPEN + 3600 });
  assert.equal(isMarketOpen(inWindow, OPEN + 3600), true);
  assert.equal(
    isMarketOpen(inWindow, OPEN + 3600, { ...OPEN_STATUS, isOpen: false, session: null }),
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

// ---- row assembly: which upstream actually priced the row -----------------

test("a Finnhub-priced row says so, with the real captured price", () => {
  const [aapl] = buildBasisPairs(jup, under([fh()]), FH_NOW, OPEN_STATUS).pairs;
  assert.equal(aapl.underPx, 333.27);
  assert.equal(aapl.tokenPx, 332.9810802801566);
  assert.deepEqual(aapl.source, { token: "jupiter", under: "finnhub" });
  assert.equal(aapl.marketOpen, true);
});

test("a memoised Finnhub quote is labelled finnhub:cached, never finnhub", () => {
  const stale = fh(FH_AAPL, "AAPL", { fetchedAt: FH_NOW - UNDER_FRESH_SEC - 1 });
  const [aapl] = buildBasisPairs(jup, under([stale]), FH_NOW, OPEN_STATUS).pairs;
  assert.equal(aapl.source.under, "finnhub:cached");
});

// While Finnhub is down the fallback fills in, and a mixed table must not
// label the fallback rows as Finnhub reads.
test("a table mixing both sources labels each row with the upstream that priced it", () => {
  const yahooNvda = quote({
    sym: "NVDA",
    px: 214.9,
    quotedAt: FH_NOW - 10,
    fetchedAt: FH_NOW,
    sessionStart: null,
    sessionEnd: null,
  });
  const { pairs } = buildBasisPairs(jup, under([fh(), yahooNvda]), FH_NOW, OPEN_STATUS);
  const bySym = new Map(pairs.map((p) => [p.sym, p]));
  assert.equal(bySym.get("AAPL")!.source.under, "finnhub");
  assert.equal(bySym.get("NVDA")!.source.under, "yahoo");
  assert.equal(bySym.get("NVDA")!.underPx, 214.9);
});

test("the exchange's status drives marketOpen on every row at once", () => {
  const rows = under([fh(), fh(FH_NVDA, "NVDA"), fh(FH_META, "META")]);
  const open = buildBasisPairs(jup, rows, FH_NOW, OPEN_STATUS).pairs;
  assert.equal(open.length, 3);
  for (const p of open) assert.equal(p.marketOpen, true, `${p.sym} should be open`);

  const closed = buildBasisPairs(jup, rows, FH_NOW, PRE_STATUS).pairs;
  assert.equal(closed.length, 3);
  for (const p of closed) assert.equal(p.marketOpen, false, `${p.sym} should be closed`);
});

// The mint rule does not relax because the underlying source changed.
test("switching the underlying source changes no mint and invents no row", () => {
  const { pairs, unresolved } = buildBasisPairs(jup, under([fh(), fh(FH_META, "META")]), FH_NOW, OPEN_STATUS);
  assert.deepEqual(pairs.map((p) => p.sym).sort(), ["AAPL", "META"]);
  for (const p of pairs) {
    assert.equal(p.mint, MINTS.find((m) => m.sym === p.sym)!.mint);
    assert.ok(p.underPx > 0 && p.tokenPx > 0);
  }
  assert.equal(pairs.length + unresolved.length, MINTS.length);
});

// ---- price/v3 overlay -----------------------------------------------------
// Regression cover for the cache-skew defect: the ~5MB tag list is cached for
// 10 minutes while the equity leg refreshes every 45s, so token prices must be
// refreshed independently or the basis measures lag instead of dislocation.

const P3 = {
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: { usdPrice: 333.5, liquidity: 720000 },
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: { usdPrice: 362.1, liquidity: 1250000 },
};

const tagIndex = () =>
  new Map<string, JupToken>([
    ["XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", { mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", symbol: "AAPLx", name: "Apple xStock", usdPrice: 300, liquidity: 1, isVerified: true }],
    ["XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", { mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", symbol: "TSLAx", name: "Tesla xStock", usdPrice: 300, liquidity: 1, isVerified: true }],
    ["XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL", { mint: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL", symbol: "NFLXx", name: "Netflix xStock", usdPrice: 75, liquidity: 3197, isVerified: true }],
  ]);

test("parseJupPrices reads the mint-keyed object", () => {
  const m = parseJupPrices(P3);
  assert.equal(m.size, 2);
  assert.equal(m.get("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp")?.usdPrice, 333.5);
});

test("parseJupPrices rejects an array, which is the tag list's shape", () => {
  assert.throws(() => parseJupPrices([{ id: "Xs1", usdPrice: 1 }]), /expected an object keyed by mint/);
});

test("parseJupPrices drops zero and missing prices rather than shipping them", () => {
  const m = parseJupPrices({ A: { usdPrice: 0 }, B: { usdPrice: null }, C: {}, D: { usdPrice: 5 } });
  assert.deepEqual([...m.keys()], ["D"]);
});

test("overlayPrices replaces the stale price and keeps identity intact", () => {
  const { index, overlaid } = overlayPrices(tagIndex(), parseJupPrices(P3));
  const aapl = index.get("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp");
  assert.equal(aapl?.usdPrice, 333.5, "price must come from price/v3");
  assert.equal(aapl?.symbol, "AAPLx", "symbol must survive: price/v3 carries none");
  assert.equal(aapl?.isVerified, true, "isVerified must survive: it gates the swap control");
  assert.equal(overlaid.length, 2);
});

test("a mint absent from price/v3 keeps its tag-list price instead of vanishing", () => {
  const { index, missed } = overlayPrices(tagIndex(), parseJupPrices(P3));
  assert.deepEqual(missed, ["XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL"]);
  assert.equal(index.get("XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL")?.usdPrice, 75);
  assert.equal(index.size, 3, "no row may be dropped by the overlay");
});

test("overlayPrices does not mutate the cached identity index", () => {
  const original = tagIndex();
  overlayPrices(original, parseJupPrices(P3));
  assert.equal(
    original.get("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp")?.usdPrice,
    300,
    "mutating the 10-minute cache would poison every later request",
  );
});

test("fresh liquidity overrides the snapshot, so drained depth closes the swap", () => {
  const drained = parseJupPrices({ XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL: { usdPrice: 75, liquidity: 12 } });
  const { index } = overlayPrices(tagIndex(), drained);
  assert.equal(index.get("XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL")?.liquidity, 12);
});

// ---- basis decomposition --------------------------------------------------
// A DEX-vs-equity gap is two things summed: pool drift from the issuer's NAV
// (tradeable) and issuer tracking error (not). Measured live, tracking error
// is near zero and pool drift carries nearly all of it, so a single number
// overstates what a swap could capture.

test("parseJupPrices reads the issuer mark out of stockData", () => {
  const m = parseJupPrices({
    Xs1: { usdPrice: 389.67, liquidity: 5, stockData: { price: 401.17, updatedAt: "2026-09-19T03:55:56.657Z" } },
  });
  const e = m.get("Xs1")!;
  assert.equal(e.issuerPx, 401.17);
  assert.equal(e.issuerAt, "2026-09-19T03:55:56.657Z");
});

test("a token with no stockData yields null, never zero", () => {
  const m = parseJupPrices({ Xs1: { usdPrice: 10 } });
  assert.equal(m.get("Xs1")!.issuerPx, null, "zero would read as a real NAV of $0");
  assert.equal(m.get("Xs1")!.issuerAt, null);
});

test("the decomposition splits GLD's real numbers correctly", () => {
  // Live 2026-09-19: DEX 389.67, issuer 401.17, equity 401.17. The issuer
  // tracked the share exactly while the pool sat 2.9% under it, so the whole
  // gap was tradeable pool drift and none of it was tracking error.
  const dexVsIssuer = bps(389.67, 401.17);
  const issuerVsEquity = bps(401.17, 401.17);
  assert.equal(dexVsIssuer, -287);
  assert.equal(issuerVsEquity, 0);
  assert.ok(Math.abs(bps(389.67, 401.17) - dexVsIssuer) < 2, "halves must reconcile to the whole");
});
