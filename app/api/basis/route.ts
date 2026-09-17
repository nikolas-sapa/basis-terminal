import { NextResponse } from "next/server";
import { MINTS } from "@/lib/mints";
import {
  type JupPrice,
  parseJupPrices,
  overlayPrices,
  indexJupiter,
  parseFinnhubQuote,
  parseMarketStatus,
  parseYahooChart,
  buildBasisPairs,
  QuoteShapeError,
  UNDER_FRESH_SEC,
  type BasisPair,
  type JupToken,
  type MarketStatus,
  type UnderQuote,
  type UnderSource,
  type Unresolved,
} from "@/lib/quotes";

/**
 * Tier 1 basis.
 *
 * `/api/pyth` is a 503 by design: Hermes has required an API key since the
 * 2026-08-26 Pyth Core upgrade and our key holds no feed grants, so both legs
 * come back `403 no grant accepts this feed`. This route is the path that
 * works today.
 *
 *   token leg       Jupiter  keyless
 *   underlying leg  Finnhub  FINNHUB_API_KEY, 60 requests/minute free
 *   underlying leg  Yahoo    keyless, FALLBACK ONLY
 *
 * Yahoo used to be the primary and could not hold the table up: measured from
 * one IP, 15 concurrent chart requests returned 3 x HTTP 200 and 12 x HTTP 429
 * followed by minutes of lockout, and the v7 batch endpoint 429s outright.
 * That code is kept, throttle budget and all, as the fallback for when Finnhub
 * is unconfigured or down. It is no longer asked to serve 15 symbols.
 */

const JUPITER_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
const FINNHUB = "https://finnhub.io/api/v1";
const finnhubQuoteUrl = (sym: string) => `${FINNHUB}/quote?symbol=${encodeURIComponent(sym)}`;
const FINNHUB_STATUS_URL = `${FINNHUB}/stock/market-status?exchange=US`;
const yahooUrl = (sym: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;

// The chart endpoint is undocumented and rejects a default fetch User-Agent.
// This is a compatibility header, nothing more.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ponytail: read at module scope exactly like PYTH_API_KEY in /api/pyth, which
// is what lets a test swap the env and re-import a fresh module to exercise
// the unconfigured path.
const KEY = process.env.FINNHUB_API_KEY;

/** Named in the failure body. The whole point of failing loud is being fixable. */
const MISSING_KEY =
  "FINNHUB_API_KEY is not set. The underlying-equity leg needs it: Yahoo's chart " +
  "endpoint throttles at roughly one request in three from a single IP and cannot " +
  "serve 15 symbols. Get a free key (60 requests/minute) at " +
  "https://finnhub.io/register and set FINNHUB_API_KEY.";

/** The verified-tag payload is ~5MB and mints do not move. Memoise the index. */
const JUPITER_TTL_MS = 10 * 60 * 1000;
const JUPITER_TIMEOUT_MS = 20_000;
/**
 * Fresh token prices, overlaid on the 10-minute identity index.
 *
 * The tag list is ~5MB so it cannot be refetched often, but the equity leg
 * refreshes every 45s. Pairing a 10-minute-old token price with a 45-second-old
 * equity price made the basis measure cache lag rather than dislocation: the
 * sign flipped on 9 of 15 rows and the table read uniformly CHEAP into a rising
 * market. A uniformly-signed basis is the signature of staleness.
 *
 * price/v3 is ~8KB for 15 mints, so 30s is affordable and stays under the
 * 45s round.
 */
const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const JUPITER_PRICE_TTL_MS = 30_000;
const FINNHUB_TIMEOUT_MS = 8_000;
const YAHOO_TIMEOUT_MS = 8_000;

/**
 * Finnhub budget: 60 requests/minute on the free tier, confirmed by the
 * response headers (`x-ratelimit-limit: 60`, `x-ratelimit-remaining`,
 * `x-ratelimit-reset`). A full round is 15 quotes; the session status is one
 * more on its own, longer clock.
 *
 *   15 quotes / 45s   = 20 req/min
 *    1 status / 30s   =  2 req/min
 *                       22 req/min, roughly a third of the allowance
 *
 * The headroom is not slack, it is instances: this memo is per server process,
 * and Vercel will happily run several. 22/min leaves room for two more before
 * the cap, which a 15s round would not.
 *
 * FINNHUB_ROUND_MS is a wall-clock floor on the whole round, not a per-symbol
 * age test, because a per-symbol test spends the budget fastest exactly when
 * the upstream is failing: every symbol stays stale, so every UI poll fires 15
 * more requests. 45s < UNDER_FRESH_SEC (60s), so a healthy leg never labels
 * its own rows `finnhub:cached`.
 */
const FINNHUB_ROUND_MS = 45_000;
const FINNHUB_STATUS_TTL_MS = 30_000;

/**
 * Throttle and auth backoff.
 *
 * A 429 is honoured against Finnhub's own `x-ratelimit-reset` header when it
 * sends one, since the quota is a fixed one-minute window and guessing longer
 * is wasted time. A 401/403 is different in kind: a missing or wrong key does
 * not come right in a minute, and retrying 15 times a minute against it just
 * pours requests into a wall.
 */
const FINNHUB_THROTTLE_COOLDOWN_MS = 60_000;
const FINNHUB_MAX_COOLDOWN_MS = 120_000;
const FINNHUB_AUTH_COOLDOWN_MS = 300_000;

/**
 * Yahoo throttle budget, unchanged from when Yahoo was primary.
 *
 * Measured 2026-09-16 from one IP: 15 concurrent chart requests returned
 * 3 x HTTP 200 and 12 x HTTP 429, and the 429s then persisted for roughly six
 * minutes of 45s-spaced retries. So the fallback refreshes at most
 * REFRESH_BUDGET symbols per invocation, oldest first.
 *
 * On a 429 the whole Yahoo leg goes quiet, and the quiet period doubles for
 * each consecutive throttled round up to COOLDOWN_MAX_MS. A flat retry keeps
 * knocking all the way through a multi-minute lockout, which is what turns a
 * short 429 into a long one. One success resets it.
 */
const REFRESH_BUDGET = 3;
const COOLDOWN_BASE_MS = 90_000;
const COOLDOWN_MAX_MS = 600_000;

/** Oldest a memoised underlying may be before the symbol is dropped entirely. */
const UNDER_MAX_AGE_SEC = 900;

export const revalidate = 0;
export const dynamic = "force-dynamic";

type Sources = { jupiter: boolean; finnhub: boolean; yahoo: boolean };

type Body = {
  pairs: BasisPair[];
  sources: Sources;
  unresolved: Unresolved[];
  fetchedAt: string;
  /** Non-fatal problems behind a 200. Empty when every leg is healthy. */
  degraded: string[];
  /** Finnhub's session answer when we have one, null when derived per row. */
  marketStatus: MarketStatus | null;
  error?: string;
};

class UpstreamError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---- module-scope memo ----------------------------------------------------

let jupiterCache: { at: number; index: Map<string, JupToken> } | null = null;
let jupiterPriceCache: { at: number; prices: Map<string, JupPrice> } | null = null;
const underCache = new Map<string, UnderQuote>();

let finnhubLastRoundAt = 0;
let finnhubCooldownUntil = 0;
/** Set by a failing fetch, applied once per round. Longest wait wins. */
type Halt = { ms: number; why: string };
let finnhubHalt: Halt | null = null;
let statusCache: { at: number; value: MarketStatus | null } | null = null;

let yahooCooldownUntil = 0;
/** Consecutive throttled refresh rounds, for the backoff above. */
let yahooStrikes = 0;
let throttledThisRound = false;

// ---- token leg: Jupiter ---------------------------------------------------

async function jupiterIndex(): Promise<Map<string, JupToken>> {
  if (jupiterCache && Date.now() - jupiterCache.at < JUPITER_TTL_MS) return jupiterCache.index;

  let r: Response;
  try {
    r = await fetch(JUPITER_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("[/api/basis] jupiter fetch threw:", e);
    throw new UpstreamError("Jupiter token list unreachable", 502);
  }

  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 200);
    console.error(`[/api/basis] jupiter HTTP ${r.status} ${r.statusText}: ${body}`);
    throw new UpstreamError(`Jupiter token list failed: ${r.status} ${body}`.trim(), 502);
  }

  let payload: unknown;
  try {
    payload = await r.json();
  } catch (e) {
    console.error("[/api/basis] jupiter returned HTTP 200 with unparseable JSON:", e);
    throw new UpstreamError("Jupiter token list returned malformed JSON", 502);
  }

  // indexJupiter throws on a 200 that carries an error object instead of an
  // array, which is how this endpoint would most plausibly report a throttle.
  let index: Map<string, JupToken>;
  try {
    index = indexJupiter(payload);
  } catch (e) {
    console.error("[/api/basis] jupiter payload rejected:", e);
    throw new UpstreamError(
      e instanceof QuoteShapeError ? e.message : "Jupiter token list had an unexpected shape",
      502,
    );
  }

  jupiterCache = { at: Date.now(), index };
  return index;
}

/**
 * Fresh prices for the allowlist mints only.
 *
 * Never throws. A failure here degrades to the tag-list price, which is stale
 * but real; dropping the table because a price refresh failed would be a worse
 * outcome than showing an older number that says how old it is.
 */
async function jupiterPrices(): Promise<{ prices: Map<string, JupPrice>; failure: string | null }> {
  if (jupiterPriceCache && Date.now() - jupiterPriceCache.at < JUPITER_PRICE_TTL_MS) {
    return { prices: jupiterPriceCache.prices, failure: null };
  }
  const ids = MINTS.map((m) => m.mint).join(",");
  try {
    const r = await fetch(`${JUPITER_PRICE_URL}?ids=${ids}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 200);
      const why = `jupiter price/v3 HTTP ${r.status} ${body}`.trim();
      console.error(`[/api/basis] ${why}`);
      return { prices: new Map(), failure: why };
    }
    const prices = parseJupPrices(await r.json());
    jupiterPriceCache = { at: Date.now(), prices };
    return { prices, failure: null };
  } catch (e) {
    const why = `jupiter price/v3 failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[/api/basis] ${why}`);
    return { prices: new Map(), failure: why };
  }
}

// ---- underlying leg: Finnhub ----------------------------------------------

function noteFinnhubHalt(ms: number, why: string) {
  // Longest wins within a round: a 401's five minutes must not be shortened by
  // a 429 that arrives in the same batch.
  if (!finnhubHalt || ms > finnhubHalt.ms) finnhubHalt = { ms, why };
}

/** Honour `x-ratelimit-reset` when Finnhub sends one, else the flat minute. */
function throttleWaitMs(r: Response): number {
  const reset = Number(r.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - Date.now();
    // +1s so we come back after the window turns over, not on its edge.
    if (wait > 0) return Math.min(wait + 1_000, FINNHUB_MAX_COOLDOWN_MS);
  }
  return FINNHUB_THROTTLE_COOLDOWN_MS;
}

/**
 * ponytail: the key travels in `X-Finnhub-Token`, never in the query string.
 * Both are documented and both work (verified), but this route logs the URL of
 * a failing request, and a token in a log line is a leaked token.
 */
const finnhubHeaders = () => ({ "X-Finnhub-Token": KEY ?? "", Accept: "application/json" });

async function fetchFinnhubQuote(sym: string, nowSec: number): Promise<UnderQuote> {
  let r: Response;
  try {
    r = await fetch(finnhubQuoteUrl(sym), {
      cache: "no-store",
      headers: finnhubHeaders(),
      signal: AbortSignal.timeout(FINNHUB_TIMEOUT_MS),
    });
  } catch (e) {
    throw new QuoteShapeError(`Finnhub ${sym} unreachable: ${String(e)}`, sym);
  }

  if (r.status === 429) {
    noteFinnhubHalt(throttleWaitMs(r), "HTTP 429, quota exhausted");
    throw new QuoteShapeError(`Finnhub ${sym}: HTTP 429`, sym);
  }
  if (r.status === 401 || r.status === 403) {
    // Verified bodies: `{"error":"Please use an API key."}` with no token,
    // `{"error":"Invalid API key."}` with a junk one.
    const body = (await r.text().catch(() => "")).slice(0, 120);
    noteFinnhubHalt(FINNHUB_AUTH_COOLDOWN_MS, `HTTP ${r.status} ${body}`.trim());
    throw new QuoteShapeError(`Finnhub ${sym}: HTTP ${r.status} ${body}`.trim(), sym);
  }
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 120);
    throw new QuoteShapeError(`Finnhub ${sym}: HTTP ${r.status} ${body}`.trim(), sym);
  }

  let payload: unknown;
  try {
    payload = await r.json();
  } catch {
    throw new QuoteShapeError(`Finnhub ${sym}: HTTP 200 with unparseable JSON`, sym);
  }

  // Throws on a missing, zero or non-numeric price, and specifically on the
  // all-zero body Finnhub returns for a symbol it does not cover. A symbol
  // that cannot be parsed keeps its previous memoised quote, falls through to
  // the Yahoo fallback, or disappears from the table. It is never given a
  // placeholder.
  return parseFinnhubQuote(sym, payload, nowSec);
}

function age(sym: string, nowSec: number): number {
  const q = underCache.get(sym);
  return q ? nowSec - q.fetchedAt : Number.MAX_SAFE_INTEGER;
}

/** One Finnhub round: every symbol whose memoised quote has aged out. */
async function refreshFinnhub(nowSec: number): Promise<{ ok: number; failures: string[] }> {
  if (!KEY) return { ok: 0, failures: [MISSING_KEY] };

  const cooldownLeft = finnhubCooldownUntil - Date.now();
  if (cooldownLeft > 0) {
    const msg = `Finnhub backing off for another ${Math.ceil(cooldownLeft / 1000)}s`;
    console.error(`[/api/basis] ${msg}`);
    return { ok: 0, failures: [msg] };
  }

  // The budget floor. Nothing below this line fires more than 15 requests per
  // FINNHUB_ROUND_MS, whatever the UI's poll interval is and however hard the
  // upstream is failing.
  if (Date.now() - finnhubLastRoundAt < FINNHUB_ROUND_MS) return { ok: 0, failures: [] };

  const due = MINTS.map((m) => m.sym).filter((sym) => age(sym, nowSec) >= FINNHUB_ROUND_MS / 1000);
  if (due.length === 0) return { ok: 0, failures: [] };

  finnhubLastRoundAt = Date.now();
  finnhubHalt = null;
  const settled = await Promise.allSettled(due.map((sym) => fetchFinnhubQuote(sym, nowSec)));

  const failures: string[] = [];
  let ok = 0;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      underCache.set(due[i], s.value);
      ok += 1;
    } else {
      failures.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
  });

  if (finnhubHalt) {
    // Read through a typed local: the compiler cannot see that a fetch in the
    // batch above assigned this, so it still has the `null` from before them.
    const halt: Halt = finnhubHalt;
    finnhubCooldownUntil = Date.now() + halt.ms;
    failures.push(`backing off ${halt.ms / 1000}s: ${halt.why}`);
  }
  if (failures.length) console.error(`[/api/basis] finnhub: ${failures.join(" | ")}`);
  return { ok, failures };
}

/**
 * The exchange's own session state, memoised.
 *
 * A failure here is never fatal: `marketOpen` falls back to the per-quote
 * timestamp rules in `isMarketOpen`. The failure is cached alongside the
 * success so a dead status endpoint costs one request per TTL rather than one
 * per UI poll.
 */
async function marketStatus(): Promise<{ value: MarketStatus | null; failure: string | null }> {
  if (!KEY) return { value: null, failure: null };
  if (statusCache && Date.now() - statusCache.at < FINNHUB_STATUS_TTL_MS) {
    return { value: statusCache.value, failure: null };
  }

  const fail = (msg: string) => {
    console.error(`[/api/basis] market-status: ${msg}`);
    statusCache = { at: Date.now(), value: null };
    return { value: null, failure: msg };
  };

  let r: Response;
  try {
    r = await fetch(FINNHUB_STATUS_URL, {
      cache: "no-store",
      headers: finnhubHeaders(),
      signal: AbortSignal.timeout(FINNHUB_TIMEOUT_MS),
    });
  } catch (e) {
    return fail(`unreachable: ${String(e)}`);
  }

  if (r.status === 429) noteFinnhubHalt(throttleWaitMs(r), "HTTP 429 on market-status");
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 120);
    return fail(`HTTP ${r.status} ${body}`.trim());
  }

  try {
    const value = parseMarketStatus(await r.json());
    statusCache = { at: Date.now(), value };
    return { value, failure: null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ---- underlying leg: Yahoo (fallback) -------------------------------------

async function fetchYahoo(sym: string, nowSec: number): Promise<UnderQuote> {
  let r: Response;
  try {
    r = await fetch(yahooUrl(sym), {
      cache: "no-store",
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
    });
  } catch (e) {
    throw new QuoteShapeError(`Yahoo ${sym} unreachable: ${String(e)}`, sym);
  }

  if (r.status === 429) {
    // Back all the way off. The escalation is applied once per round in
    // refreshYahoo, so a batch of three 429s counts as one strike.
    throttledThisRound = true;
    throw new QuoteShapeError(`Yahoo ${sym}: HTTP 429`, sym);
  }
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 120);
    throw new QuoteShapeError(`Yahoo ${sym}: HTTP ${r.status} ${body}`.trim(), sym);
  }

  let payload: unknown;
  try {
    payload = await r.json();
  } catch {
    throw new QuoteShapeError(`Yahoo ${sym}: HTTP 200 with unparseable JSON`, sym);
  }

  // Throws on a missing, zero or non-numeric price. Same contract as Finnhub:
  // a symbol that cannot be parsed is never given a placeholder.
  return parseYahooChart(sym, payload, nowSec);
}

/**
 * Fill the gaps Finnhub left, within the Yahoo throttle budget.
 *
 * No explicit "is Finnhub up" test: a symbol is due only when its memoised
 * quote is missing or older than UNDER_FRESH_SEC (60s), and a healthy Finnhub
 * leg refreshes every 45s, so a healthy Finnhub leg leaves nothing due and
 * this never fires a request.
 */
async function refreshYahoo(nowSec: number): Promise<{ ok: number; failures: string[] }> {
  const due = MINTS.map((m) => m.sym)
    .filter((sym) => age(sym, nowSec) >= UNDER_FRESH_SEC)
    .sort((a, b) => age(b, nowSec) - age(a, nowSec))
    .slice(0, REFRESH_BUDGET);

  if (due.length === 0) return { ok: 0, failures: [] };

  const cooldownLeft = yahooCooldownUntil - Date.now();
  if (cooldownLeft > 0) {
    const msg = `Yahoo throttled, serving memoised quotes for another ${Math.ceil(cooldownLeft / 1000)}s`;
    console.error(`[/api/basis] ${msg}`);
    return { ok: 0, failures: [msg] };
  }

  throttledThisRound = false;
  const settled = await Promise.allSettled(due.map((sym) => fetchYahoo(sym, nowSec)));
  const failures: string[] = [];
  let ok = 0;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      underCache.set(due[i], s.value);
      ok += 1;
    } else {
      failures.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
  });

  if (ok > 0) yahooStrikes = 0;
  if (throttledThisRound) {
    yahooStrikes += 1;
    const wait = Math.min(COOLDOWN_BASE_MS * 2 ** (yahooStrikes - 1), COOLDOWN_MAX_MS);
    yahooCooldownUntil = Date.now() + wait;
    failures.push(`backing off ${wait / 1000}s after ${yahooStrikes} throttled round(s)`);
  }

  if (failures.length) console.error(`[/api/basis] yahoo: ${failures.join(" | ")}`);
  return { ok, failures };
}

// ---- handler --------------------------------------------------------------

/** Memoised quotes young enough to price against. Anything older is dropped. */
function usableUnderlyings(nowSec: number): Map<string, UnderQuote> {
  const usable = new Map<string, UnderQuote>();
  for (const [sym, q] of underCache) {
    if (nowSec - q.fetchedAt <= UNDER_MAX_AGE_SEC) usable.set(sym, q);
    else underCache.delete(sym);
  }
  return usable;
}

const countFrom = (under: Map<string, UnderQuote>, provider: UnderSource) => {
  let n = 0;
  for (const q of under.values()) if (q.provider === provider) n += 1;
  return n;
};

const fail = (
  body: { pairs: BasisPair[]; unresolved: Unresolved[]; error: string; degraded: string[] },
  sources: Sources,
  status: number,
) =>
  NextResponse.json<Body>(
    { ...body, sources, marketStatus: null, fetchedAt: new Date().toISOString() },
    { status },
  );

const allUnresolved = (reason: string): Unresolved[] =>
  MINTS.map((m) => ({ sym: m.sym, reason }));

export async function GET() {
  const nowSec = Math.floor(Date.now() / 1000);

  let jup: Map<string, JupToken>;
  try {
    jup = await jupiterIndex();
  } catch (e) {
    const operational = e instanceof UpstreamError;
    if (!operational) console.error("[/api/basis] unhandled in token leg:", e);
    const error = operational ? e.message : "Internal Server Error";
    // No token leg means no row can exist. HTTP 200 with an empty `pairs` would
    // render as a clean empty table and read as "no basis today".
    return fail(
      { pairs: [], unresolved: allUnresolved(error), error, degraded: [] },
      { jupiter: false, finnhub: false, yahoo: false },
      operational ? (e as UpstreamError).status : 500,
    );
  }

  // Layer fresh prices over the 10-minute identity index. Without this the
  // basis subtracts a 45-second-old equity price from a token price up to ten
  // minutes old, which measures cache lag, not dislocation.
  const priced = await jupiterPrices();
  const { index: jupFresh, missed } = overlayPrices(jup, priced.prices);
  jup = jupFresh;

  const [finn, status] = await Promise.all([refreshFinnhub(nowSec), marketStatus()]);
  // Only ever fires for symbols Finnhub did not fill. See refreshYahoo.
  const yahoo = await refreshYahoo(nowSec);

  const under = usableUnderlyings(nowSec);
  const { pairs, unresolved } = buildBasisPairs(jup, under, nowSec, status.value);

  // Every attempt this request failed, or we were still in a cooldown and made
  // none. Cached rows may still render, but the leg is down and the UI gets
  // told so rather than inferring health from a non-empty table.
  const finnhubDown = finn.ok === 0 && finn.failures.length > 0;
  const yahooDown = yahoo.ok === 0 && yahoo.failures.length > 0;

  const degraded = [
    ...finn.failures.map((f) => `finnhub: ${f}`),
    ...yahoo.failures.map((f) => `yahoo: ${f}`),
    ...(status.failure ? [`market-status: ${status.failure}`] : []),
  ];

  if (pairs.length === 0) {
    const error = KEY
      ? `No basis rows could be built: Jupiter returned ${jup.size} tokens, ` +
        `the underlying leg yielded ${under.size} usable quotes` +
        (degraded.length ? `. ${degraded.join(" | ")}` : ".")
      : `${MISSING_KEY} The Yahoo fallback yielded ${under.size} usable quotes` +
        (yahoo.failures.length ? `: ${yahoo.failures.join(" | ")}` : ".");
    console.error(`[/api/basis] ${error}`);
    return fail(
      {
        pairs: [],
        unresolved: unresolved.length ? unresolved : allUnresolved(error),
        error,
        degraded,
      },
      { jupiter: true, finnhub: false, yahoo: false },
      // Unconfigured is not the same failure as unreachable, and the fix is
      // different: 503 says set the variable, 502 says the upstream is down.
      KEY ? 502 : 503,
    );
  }

  if (unresolved.length) {
    console.error(
      `[/api/basis] ${pairs.length}/${MINTS.length} rows; unresolved: ` +
        unresolved.map((u) => `${u.sym} (${u.reason})`).join(", "),
    );
  }

  return NextResponse.json<Body>({
    pairs,
    sources: {
      jupiter: true,
      // False while a leg is failing, even though memoised rows from it still
      // render. Each row says which upstream it got and how fresh: a quote
      // older than UNDER_FRESH_SEC is labelled `finnhub:cached`, never
      // `finnhub`.
      finnhub: countFrom(under, "finnhub") > 0 && !finnhubDown,
      yahoo: countFrom(under, "yahoo") > 0 && !yahooDown,
    },
    unresolved,
    degraded,
    marketStatus: status.value,
    fetchedAt: new Date().toISOString(),
  });
}
