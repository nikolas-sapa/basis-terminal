import { bps, verdict } from "./basis.ts";
import { MINTS, isTradeable, type Mint } from "./mints.ts";

/**
 * Keyless replacement for the Tier 1 price legs.
 *
 * Pyth Hermes stopped serving prices anonymously on 2026-08-26 and our key
 * holds no feed grants, so `/api/pyth` is a 503 by design. This module is the
 * path that works today:
 *
 *   token leg       Jupiter  GET /tokens/v2/tag?query=verified   (keyless)
 *   underlying leg  Yahoo    GET /v8/finance/chart/<SYM>         (keyless)
 *
 * Everything here is pure. All IO lives in `app/api/basis/route.ts`, which is
 * what makes the matching and mapping rules below testable without a network.
 */

/** Seconds after which a quote is a last close rather than a live tick. */
export const QUOTE_STALE_SEC = 900;

/**
 * Seconds after which a cached underlying is labelled `yahoo:cached`.
 *
 * Yahoo hard-throttles: a burst of 15 concurrent chart requests measured
 * 3 x HTTP 200 and 12 x HTTP 429, followed by roughly six minutes of lockout.
 * The route therefore serves a memoised quote between refreshes, and this is
 * the age at which the row stops claiming to be a fresh read.
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
};

/** One underlying equity quote, parsed out of a Yahoo chart response. */
export type UnderQuote = {
  sym: string;
  px: number;
  currency: string | null;
  /** `meta.regularMarketTime`: when the print happened, not when we fetched. */
  quotedAt: number | null;
  /** `meta.currentTradingPeriod.regular`, epoch seconds. Null when absent. */
  sessionStart: number | null;
  sessionEnd: number | null;
  /** When this process fetched it, for the cache-age label. */
  fetchedAt: number;
};

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
  };
}

/**
 * Is the underlying's exchange actually trading right now?
 *
 * ponytail: derived from the payload's own timestamps, with no clock or
 * timezone arithmetic anywhere in this repo.
 *
 * `meta.marketState` is NOT used: it is absent from the chart response
 * entirely (a probe reported it as null), so anything built on it would be
 * silently false for every row.
 *
 * Two conditions, and both are needed:
 *
 *  1. `now` falls inside `currentTradingPeriod.regular`, the session window
 *     Yahoo publishes in epoch seconds alongside the quote. This is what
 *     catches 16:00:01 ET, when the last print is seconds old but the bell has
 *     rung. A freshness-only rule calls that market open for 15 more minutes.
 *  2. `regularMarketTime` is younger than QUOTE_STALE_SEC. This is what catches
 *     a market holiday, where Yahoo still publishes a nominal 09:30-16:00
 *     window but the last print is from the previous session.
 *
 * If `currentTradingPeriod` is ever absent, condition 2 stands alone. That is
 * weaker (it keeps saying "open" for up to 15 minutes after the close) but it
 * still never claims an overnight last close is live, and it still needs no
 * hardcoded US/Eastern rules.
 */
export function isMarketOpen(q: UnderQuote, nowSec: number): boolean {
  const fresh = q.quotedAt !== null && nowSec - q.quotedAt < QUOTE_STALE_SEC;
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
      unresolved.push({ sym: m.sym, reason: "no underlying quote from Yahoo" });
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
      marketOpen: isMarketOpen(u, nowSec),
      liquidityUsd,
      tradeable,
      source: {
        token: "jupiter",
        under: nowSec - u.fetchedAt > UNDER_FRESH_SEC ? "yahoo:cached" : "yahoo",
      },
    });
  }

  return { pairs: pairs.sort((a, b2) => Math.abs(b2.bps) - Math.abs(a.bps)), unresolved };
}
