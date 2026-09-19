import { bps, verdict } from "./basis.ts";
import { MINTS, isTradeable, type Mint } from "./mints.ts";

/**
 * The Tier 1 price legs.
 *
 * Pyth Hermes stopped serving prices anonymously on 2026-08-26 and our key
 * holds no feed grants, so `/api/pyth` is a 503 by design. This module is the
 * path that works today:
 *
 *   token leg       Jupiter  GET /tokens/v2/tag?query=verified   (keyless)
 *   underlying leg  Finnhub  GET /api/v1/quote?symbol=<SYM>      (FINNHUB_API_KEY)
 *   underlying leg  Yahoo    GET /v8/finance/chart/<SYM>         (keyless, FALLBACK)
 *
 * Yahoo was the primary underlying source and could not hold the table up:
 * measured from one IP, 15 concurrent chart requests returned 3 x HTTP 200 and
 * 12 x HTTP 429 and then locked the IP out for minutes, and the v7 batch
 * endpoint 429s outright. It is kept as the fallback for when Finnhub is
 * unconfigured or down, because a degraded source beats no source; it is no
 * longer asked to serve all 15 symbols.
 *
 * Everything here is pure. All IO lives in `app/api/basis/route.ts`, which is
 * what makes the matching and mapping rules below testable without a network.
 */

/** Seconds after which a quote is a last close rather than a live tick. */
export const QUOTE_STALE_SEC = 900;

/**
 * Seconds after which a cached underlying is labelled `<provider>:cached`.
 *
 * Neither underlying source is polled on every UI poll: Finnhub's free tier is
 * 60 requests/minute and Yahoo hard-throttles (3 x 200, 12 x 429 on a burst of
 * 15, then minutes of lockout). The route therefore serves a memoised quote
 * between refreshes, and this is the age at which a row stops claiming to be a
 * fresh read. It sits above the route's Finnhub refresh interval, so a healthy
 * Finnhub leg never labels itself cached.
 */
export const UNDER_FRESH_SEC = 60;

/** A token entry from Jupiter's verified-tag list, narrowed to what we use. */
export type JupToken = {
  /** Solana mint address. Jupiter calls this `id`. The only key we match on. */
  mint: string;
  symbol: string;
  name: string;
  usdPrice: number;
  /** Reported DEX liquidity in USD. `null` when Jupiter omits it. */
  liquidity: number | null;
  isVerified: boolean;
  /** Issuer NAV, present only once the price overlay has run. */
  issuerPx?: number | null;
  issuerAt?: string | null;
};

/**
 * A fresh price for one mint, from Jupiter's `price/v3` endpoint.
 *
 * WHY THIS EXISTS: the verified-tag list is ~5MB, so it is cached for 10
 * minutes, but the underlying equity leg refreshes every 45s. Subtracting a
 * 10-minute-old token price from a 45-second-old equity price produces a basis
 * dominated by cache skew rather than dislocation: measured live, the sign
 * flipped on 9 of 15 rows and the whole table read uniformly CHEAP while the
 * equity market was rising. A uniformly-signed basis is the signature of lag,
 * not of fifteen simultaneous arbitrage opportunities.
 *
 * `price/v3` carries no `symbol` and no `isVerified`, so it OVERLAYS the tag
 * list rather than replacing it. Replacing it would delete both the impostor
 * defence and the swap gate.
 */
export type JupPrice = {
  usdPrice: number;
  liquidity: number | null;
  /**
   * The issuer's own reference price for the xStock, from `stockData.price`.
   *
   * This is the third price in the system and it is what makes a basis
   * interpretable. A gap between the DEX and the underlying equity is two
   * different things added together: how far the pool has drifted from the
   * issuer's NAV, and how well the issuer tracks the real share. Only the
   * first is tradeable. Measured live, issuer-vs-equity sits near zero across
   * the board while DEX-vs-issuer carries almost the entire gap, so without
   * this split every row overstates what a trade could capture.
   */
  issuerPx: number | null;
  /** When the issuer last republished. A stale mark is not a NAV. */
  issuerAt: string | null;
};

/** Parse `price/v3`, which is an object keyed by mint, not an array. */
export function parseJupPrices(payload: unknown): Map<string, JupPrice> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuoteShapeError(
      `Jupiter price/v3 returned ${payload === null ? "null" : Array.isArray(payload) ? "an array" : typeof payload}, expected an object keyed by mint`,
    );
  }
  const out = new Map<string, JupPrice>();
  for (const [mint, v] of Object.entries(payload as Record<string, unknown>)) {
    const e = v as Record<string, unknown> | null;
    const usdPrice = num(e?.usdPrice);
    if (usdPrice === null || usdPrice <= 0) continue;
    const sd = (e?.stockData ?? null) as Record<string, unknown> | null;
    out.set(mint, {
      usdPrice,
      liquidity: num(e?.liquidity),
      issuerPx: num(sd?.price),
      issuerAt: typeof sd?.updatedAt === "string" ? sd.updatedAt : null,
    });
  }
  return out;
}

/**
 * Return a copy of the identity index with fresh prices layered on.
 *
 * A mint absent from `prices` keeps its tag-list price rather than being
 * dropped: a stale price is worse than a fresh one but far better than a
 * missing row, and the row still reports its age through `tokenFresh`.
 */
export function overlayPrices(
  index: Map<string, JupToken>,
  prices: Map<string, JupPrice>,
): { index: Map<string, JupToken>; overlaid: string[]; missed: string[] } {
  const out = new Map<string, JupToken>();
  const overlaid: string[] = [];
  const missed: string[] = [];
  for (const [mint, t] of index) {
    const fresh = prices.get(mint);
    if (fresh) {
      out.set(mint, {
        ...t,
        usdPrice: fresh.usdPrice,
        liquidity: fresh.liquidity ?? t.liquidity,
        issuerPx: fresh.issuerPx,
        issuerAt: fresh.issuerAt,
      });
      overlaid.push(mint);
    } else {
      out.set(mint, t);
      missed.push(mint);
    }
  }
  return { index: out, overlaid, missed };
}

/** Which upstream an underlying quote came from. Carried on every row. */
export type UnderSource = "finnhub" | "yahoo";

/** One underlying equity quote, normalised across the two sources. */
export type UnderQuote = {
  sym: string;
  px: number;
  /** ISO currency when the payload states one. Finnhub's /quote does not. */
  currency: string | null;
  /** When the print happened, not when we fetched. Null when unstated. */
  quotedAt: number | null;
  /**
   * Regular-session window in epoch seconds, when the payload carries one.
   * Yahoo publishes it in `meta.currentTradingPeriod.regular`; Finnhub does
   * not, which is what `/stock/market-status` is for.
   */
  sessionStart: number | null;
  sessionEnd: number | null;
  /** When this process fetched it, for the cache-age label. */
  fetchedAt: number;
  provider: UnderSource;
};

/**
 * Finnhub's authoritative per-exchange session state.
 *
 * `GET /api/v1/stock/market-status?exchange=US`. This replaces clock and
 * timezone arithmetic with the exchange's own answer, and it is the only thing
 * in the stack that knows about market holidays by name.
 */
export type MarketStatus = {
  exchange: string;
  isOpen: boolean;
  /** `pre-market` | `regular` | `post-market`, or null when closed. */
  session: string | null;
  /** Holiday event name when one applies. */
  holiday: string | null;
  /** Finnhub's own clock at the time of the answer. */
  t: number | null;
};

/** The only session in which a US equity basis is a live basis. */
const REGULAR_SESSION = "regular";

export type BasisPair = {
  sym: string;
  tokenSym: string;
  mint: string;
  tokenPx: number;
  underPx: number;
  bps: number;
  verdict: string;
  marketOpen: boolean;
  liquidityUsd: number;
  tradeable: boolean;
  source: { token: string; under: string };
  /** Issuer NAV for the token, when the issuer published one. */
  issuerPx: number | null;
  issuerAt: string | null;
  /**
   * The tradeable half: how far the DEX pool sits from the issuer's own NAV.
   * This is the part a swap can actually capture.
   */
  dexVsIssuerBps: number | null;
  /**
   * The other half: how well the issuer tracks the real share. Near zero in
   * practice, and not something a swap on this venue can act on.
   */
  issuerVsEquityBps: number | null;
};

export type Unresolved = { sym: string; reason: string };

/**
 * An upstream answered but the payload cannot be trusted.
 *
 * Explicit field, not a parameter property: parameter properties are TS syntax
 * Node's strip-only loader rejects, which would make this module unloadable by
 * `node --test`. Same reason as `UpstreamError` in the Pyth route.
 */
export class QuoteShapeError extends Error {
  sym: string | null;
  constructor(message: string, sym: string | null = null) {
    super(message);
    this.name = "QuoteShapeError";
    this.sym = sym;
  }
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Index Jupiter's verified-tag payload by MINT ADDRESS.
 *
 * ponytail: keyed on mint and never on symbol. In the payload this was written
 * against, three verified tokens answer to some case of "META": MetaDAO at
 * $4.53, a token literally named META at $4,564, and METAx, the tokenized Meta
 * Platforms share, at $673. Ninety-two symbols in that one response are
 * duplicated. Off the verified tag it is worse: a symbol search for the
 * uppercase tickers returns a pump.fun impostor for every single xStock. The
 * mint is the only unambiguous key, so it is the only key used.
 *
 * Throws rather than returning an empty map: an empty index would drop every
 * row and render as a clean, wrong, empty table.
 */
export function indexJupiter(payload: unknown): Map<string, JupToken> {
  if (!Array.isArray(payload)) {
    throw new QuoteShapeError(
      `Jupiter returned ${payload === null ? "null" : typeof payload}, expected an array`,
    );
  }

  const byMint = new Map<string, JupToken>();
  for (const e of payload) {
    const mint = typeof e?.id === "string" ? e.id : null;
    const usdPrice = num(e?.usdPrice);
    // A zero or missing price is not a price. Dropping the entry sends the
    // symbol to `unresolved`; keeping it would ship a -10000 bps basis.
    if (!mint || usdPrice === null || usdPrice <= 0) continue;
    byMint.set(mint, {
      mint,
      symbol: typeof e.symbol === "string" ? e.symbol : "",
      name: typeof e.name === "string" ? e.name : "",
      usdPrice,
      liquidity: num(e.liquidity),
      isVerified: e.isVerified === true,
    });
  }

  if (byMint.size === 0) {
    throw new QuoteShapeError(
      `Jupiter returned ${payload.length} entries but none carried a usable mint and price`,
    );
  }
  return byMint;
}

/**
 * Parse one Finnhub `/api/v1/quote` response into an underlying quote.
 *
 * Shape VERIFIED against live 200s on 2026-09-16, and it matches the OpenAPI
 * definitions the docs page embeds:
 *
 *   GET /api/v1/quote?symbol=AAPL
 *   {"c":333.27,"d":1.93,"dp":0.5825,"h":335.48,"l":331.87,"o":331.96,
 *    "pc":331.34,"t":1789580577}
 *
 *   c current price · d change · dp percent change · h high · l low
 *   o open · pc previous close · t last-trade time, epoch seconds
 *
 * Only `c` is required here; `t` is read defensively because a missing one
 * costs the row nothing but its live/stale label. ETFs are covered on the free
 * tier: SPY answered `{"c":759.58,...}` in the same batch.
 *
 * Auth failures were probed keyless and are real: no token gives HTTP 401
 * `{"error":"Please use an API key."}`, a junk token HTTP 401
 * `{"error":"Invalid API key."}`.
 */
export function parseFinnhubQuote(sym: string, payload: unknown, fetchedAtSec: number): UnderQuote {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuoteShapeError(
      `Finnhub ${sym}: expected an object, got ${payload === null ? "null" : typeof payload}`,
      sym,
    );
  }

  const q = payload as Record<string, unknown>;

  // Finnhub reports auth and quota failures as `{"error": "..."}`. Those
  // arrive with a non-200 today, but a 200 carrying an error object is how
  // several APIs report a throttle and it must never be read as a price.
  if (typeof q.error === "string") {
    throw new QuoteShapeError(`Finnhub ${sym}: ${q.error.slice(0, 120)}`, sym);
  }

  const px = num(q.c);

  // VERIFIED: an unknown or uncovered symbol does not 404. It answers HTTP 200
  // with `{"c":0,"d":null,"dp":null,"h":0,"l":0,"o":0,"pc":0,"t":0}`. That is
  // precisely the payload that would ship a $0 underlying and a -10000 bps
  // basis, so it is named and thrown. `d`/`dp` are null there, not zero, which
  // is why the all-zero test reads c/pc/h/l and not the change fields.
  if (px === 0 && num(q.pc) === 0 && num(q.h) === 0 && num(q.l) === 0) {
    throw new QuoteShapeError(
      `Finnhub ${sym}: all-zero quote, the symbol is unknown or not covered by this plan`,
      sym,
    );
  }
  if (px === null || px <= 0) {
    throw new QuoteShapeError(`Finnhub ${sym}: c is ${JSON.stringify(q.c)}`, sym);
  }

  const t = num(q.t);
  return {
    sym,
    px,
    // The payload states no currency. `/quote` is documented US-only and the
    // symbol set is the committed MINTS list, so there is nothing to
    // cross-check against; an assumed "USD" would be invented data.
    currency: null,
    quotedAt: t !== null && t > 0 ? t : null,
    // Finnhub publishes no session window on a quote. `/stock/market-status`
    // carries it instead, and `isMarketOpen` takes it as its third argument.
    sessionStart: null,
    sessionEnd: null,
    fetchedAt: fetchedAtSec,
    provider: "finnhub",
  };
}

/**
 * Parse `GET /api/v1/stock/market-status?exchange=US`.
 *
 * VERIFIED live on 2026-09-16 at 13:43 ET, mid-session:
 *
 *   {"exchange":"US","holiday":null,"isOpen":true,"session":"regular",
 *    "t":1789580601,"timezone":"America/New_York"}
 *
 * Finnhub's published sample shows the other side of it, and that is the
 * useful part: `{"isOpen":false,"session":"pre-market"}`. `isOpen` is already
 * false during pre-market, so it tracks the regular session and not an
 * extended one.
 *
 * `isOpen` is the only required field. A payload without a boolean there is
 * not a market status, and guessing one would put a "market open" badge on a
 * Sunday.
 */
export function parseMarketStatus(payload: unknown): MarketStatus {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuoteShapeError(
      `Finnhub market-status: expected an object, got ${payload === null ? "null" : typeof payload}`,
    );
  }

  const s = payload as Record<string, unknown>;
  if (typeof s.error === "string") {
    throw new QuoteShapeError(`Finnhub market-status: ${s.error.slice(0, 120)}`);
  }
  if (typeof s.isOpen !== "boolean") {
    throw new QuoteShapeError(
      `Finnhub market-status: isOpen is ${JSON.stringify(s.isOpen)}, expected a boolean`,
    );
  }

  return {
    exchange: typeof s.exchange === "string" ? s.exchange : "",
    isOpen: s.isOpen,
    session: typeof s.session === "string" ? s.session : null,
    holiday: typeof s.holiday === "string" ? s.holiday : null,
    t: num(s.t),
  };
}

/**
 * Parse one Yahoo chart response into an underlying quote.
 *
 * Every failure throws. A symbol that cannot be parsed is omitted from the
 * table and named in `unresolved`; it never appears with a guessed price.
 */
export function parseYahooChart(sym: string, payload: unknown, fetchedAtSec: number): UnderQuote {
  const chart = (payload as { chart?: unknown } | null)?.chart as
    | { error?: unknown; result?: unknown }
    | undefined;

  if (!chart || typeof chart !== "object") {
    throw new QuoteShapeError(`Yahoo ${sym}: no chart object in the response`, sym);
  }
  if (chart.error) {
    throw new QuoteShapeError(
      `Yahoo ${sym}: ${JSON.stringify(chart.error).slice(0, 160)}`,
      sym,
    );
  }
  if (!Array.isArray(chart.result) || chart.result.length === 0) {
    throw new QuoteShapeError(`Yahoo ${sym}: chart.result is empty`, sym);
  }

  const meta = chart.result[0]?.meta;
  if (!meta || typeof meta !== "object") {
    throw new QuoteShapeError(`Yahoo ${sym}: chart.result[0].meta is missing`, sym);
  }

  const px = num(meta.regularMarketPrice);
  if (px === null || px <= 0) {
    throw new QuoteShapeError(
      `Yahoo ${sym}: regularMarketPrice is ${JSON.stringify(meta.regularMarketPrice)}`,
      sym,
    );
  }

  const currency = typeof meta.currency === "string" ? meta.currency : null;
  // Every xStock is USD-denominated. A ticker that resolves to a foreign
  // listing would produce a basis in two different currencies, which is not a
  // basis at all.
  if (currency !== null && currency !== "USD") {
    throw new QuoteShapeError(`Yahoo ${sym}: quoted in ${currency}, not USD`, sym);
  }

  const regular = (meta.currentTradingPeriod as { regular?: unknown } | undefined)?.regular as
    | { start?: unknown; end?: unknown }
    | undefined;

  return {
    sym,
    px,
    currency,
    quotedAt: num(meta.regularMarketTime),
    sessionStart: regular ? num(regular.start) : null,
    sessionEnd: regular ? num(regular.end) : null,
    fetchedAt: fetchedAtSec,
    provider: "yahoo",
  };
}

/**
 * Is the underlying's exchange actually trading right now?
 *
 * ponytail: no clock or timezone arithmetic anywhere in this repo. The answer
 * comes from the exchange (Finnhub `/stock/market-status`) or from the
 * payload's own timestamps (Yahoo), never from `new Date()` and a table of US
 * holidays.
 *
 * `meta.marketState` is NOT used: it is absent from Yahoo's chart response
 * entirely (a probe reported it as null), so anything built on it would be
 * silently false for every row.
 *
 * Quote freshness is a condition in every branch. `status` answers "is the
 * bell ringing", which is not the same question as "is this number a live
 * tick": a row whose last print is 20 minutes old during an open session is
 * still a stale number and is not drawn as a live one.
 *
 * With a `status` the exchange's own answer wins, and the row must be in the
 * REGULAR session. Finnhub's own sample has `isOpen:false` during pre-market,
 * so the session check is belt and braces; if the two ever disagree this fails
 * towards "closed", which is the honest direction.
 *
 * Without one it falls back to Yahoo's published window:
 *
 *  1. `now` inside `currentTradingPeriod.regular`. This catches 16:00:01 ET,
 *     when the last print is seconds old but the bell has rung. A
 *     freshness-only rule calls that market open for 15 more minutes.
 *  2. `regularMarketTime` younger than QUOTE_STALE_SEC. This catches a market
 *     holiday, where Yahoo still publishes a nominal 09:30-16:00 window but
 *     the last print is from the previous session.
 *
 * If the window is absent too, condition 2 stands alone. That is weaker (it
 * keeps saying "open" for up to 15 minutes after the close) but it still never
 * claims an overnight last close is live. Every Finnhub quote lands in that
 * branch when the status endpoint is down, since a Finnhub quote carries no
 * session window of its own.
 */
export function isMarketOpen(
  q: UnderQuote,
  nowSec: number,
  status: MarketStatus | null = null,
): boolean {
  const fresh = q.quotedAt !== null && nowSec - q.quotedAt < QUOTE_STALE_SEC;
  if (status) return fresh && status.isOpen && status.session === REGULAR_SESSION;
  if (q.sessionStart === null || q.sessionEnd === null) return fresh;
  return fresh && nowSec >= q.sessionStart && nowSec < q.sessionEnd;
}

/**
 * Join the two legs into the Tier 1 basis table.
 *
 * Iterates the committed mint list, never the upstream payloads, so an upstream
 * can only ever remove a row from the table, never add one.
 */
export function buildBasisPairs(
  jupByMint: Map<string, JupToken>,
  underBySym: Map<string, UnderQuote>,
  nowSec: number,
  status: MarketStatus | null = null,
): { pairs: BasisPair[]; unresolved: Unresolved[] } {
  const pairs: BasisPair[] = [];
  const unresolved: Unresolved[] = [];

  for (const m of MINTS) {
    const t = jupByMint.get(m.mint);
    if (!t) {
      unresolved.push({ sym: m.sym, reason: `no Jupiter entry for mint ${m.mint}` });
      continue;
    }
    // Defence in depth behind the mint lookup. The mint is the key, so this
    // cannot fire on a symbol collision; it fires if the token at one of our
    // committed mints ever starts answering to a different ticker, which would
    // mean a migration or a bad row in lib/mints.ts. Drop it rather than price it.
    if (t.symbol !== m.tokenSym) {
      unresolved.push({
        sym: m.sym,
        reason: `Jupiter ticker at ${m.mint} is "${t.symbol}", expected "${m.tokenSym}"`,
      });
      continue;
    }

    const u = underBySym.get(m.sym);
    if (!u) {
      unresolved.push({ sym: m.sym, reason: "no underlying quote from Finnhub or Yahoo" });
      continue;
    }

    // Live depth when Jupiter reports it, the committed snapshot otherwise.
    const liquidityUsd = t.liquidity ?? m.liquidityUsd;
    const live: Mint = { ...m, liquidityUsd };
    // Both the committed snapshot and live depth must clear the floor, so a
    // drained pool loses its swap control without waiting for a redeploy, and a
    // momentary Jupiter spike cannot promote a token the snapshot rejected.
    // Verification gates the action too: a price is a claim, a swap is funds.
    const tradeable = t.isVerified && isTradeable(m) && isTradeable(live);

    const b = bps(t.usdPrice, u.px);
    pairs.push({
      sym: m.sym,
      tokenSym: m.tokenSym,
      mint: m.mint,
      tokenPx: t.usdPrice,
      underPx: u.px,
      bps: b,
      verdict: verdict(b),
      marketOpen: isMarketOpen(u, nowSec, status),
      liquidityUsd,
      tradeable,
      source: {
        token: "jupiter",
        // Which upstream actually produced this number, and whether it is this
        // round's read or a memoised one. A UI that labels every row "finnhub"
        // while the leg is down is the failure this field exists to prevent.
        under: nowSec - u.fetchedAt > UNDER_FRESH_SEC ? `${u.provider}:cached` : u.provider,
      },
      issuerPx: t.issuerPx ?? null,
      issuerAt: t.issuerAt ?? null,
      // Split the gap into the half a swap can capture and the half it cannot.
      // Null rather than zero when the issuer published nothing: a missing
      // decomposition must read as unknown, never as "no difference".
      dexVsIssuerBps: t.issuerPx ? bps(t.usdPrice, t.issuerPx) : null,
      issuerVsEquityBps: t.issuerPx ? bps(t.issuerPx, u.px) : null,
    });
  }

  return { pairs: pairs.sort((a, b2) => Math.abs(b2.bps) - Math.abs(a.bps)), unresolved };
}
