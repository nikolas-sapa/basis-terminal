import { NextResponse } from "next/server";
import { MINTS } from "@/lib/mints";
import {
  indexJupiter,
  parseYahooChart,
  buildBasisPairs,
  QuoteShapeError,
  UNDER_FRESH_SEC,
  type BasisPair,
  type JupToken,
  type UnderQuote,
  type Unresolved,
} from "@/lib/quotes";

/**
 * Tier 1 basis, keyless.
 *
 * `/api/pyth` is a 503 by design: Hermes has required an API key since the
 * 2026-08-26 Pyth Core upgrade and our key holds no feed grants, so both legs
 * come back `403 no grant accepts this feed`. This route is the path that
 * works today. Both upstreams are keyless and both are fetched server-side.
 */

const JUPITER_URL = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
const yahooUrl = (sym: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;

// The chart endpoint 403s a bare fetch. It is undocumented, so this is a
// compatibility header, not an attempt to look like anything we are not.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** The verified-tag payload is ~5MB and mints do not move. Memoise the index. */
const JUPITER_TTL_MS = 10 * 60 * 1000;
const JUPITER_TIMEOUT_MS = 20_000;
const YAHOO_TIMEOUT_MS = 8_000;

/**
 * Yahoo throttle budget.
 *
 * Measured 2026-09-16 from one IP: 15 concurrent chart requests returned
 * 3 x HTTP 200 and 12 x HTTP 429, and the 429s then persisted for roughly six
 * minutes of 45s-spaced retries. So the route refreshes at most
 * REFRESH_BUDGET symbols per invocation, oldest first, and leaves the rest on
 * their memoised quote. At the UI's 10s poll that walks all 15 symbols in
 * about 50 seconds and then holds them there.
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

type Body = {
  pairs: BasisPair[];
  sources: { jupiter: boolean; yahoo: boolean };
  unresolved: Unresolved[];
  fetchedAt: string;
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
const underCache = new Map<string, UnderQuote>();
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

// ---- underlying leg: Yahoo ------------------------------------------------

async function fetchUnder(sym: string, nowSec: number): Promise<UnderQuote> {
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
    // refreshUnderlyings, so a batch of three 429s counts as one strike.
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

  // Throws on a missing, zero or non-numeric price. A symbol that cannot be
  // parsed keeps its previous memoised quote or disappears from the table; it
  // is never given a placeholder.
  return parseYahooChart(sym, payload, nowSec);
}

/** Refresh the most stale symbols within the throttle budget. */
async function refreshUnderlyings(
  nowSec: number,
): Promise<{ ok: number; failures: string[] }> {
  const cooldownLeft = yahooCooldownUntil - Date.now();
  if (cooldownLeft > 0) {
    const msg = `Yahoo throttled, serving memoised quotes for another ${Math.ceil(cooldownLeft / 1000)}s`;
    console.error(`[/api/basis] ${msg}`);
    return { ok: 0, failures: [msg] };
  }

  const age = (sym: string) => {
    const q = underCache.get(sym);
    return q ? nowSec - q.fetchedAt : Number.MAX_SAFE_INTEGER;
  };
  const due = MINTS.map((m) => m.sym)
    .filter((sym) => age(sym) >= UNDER_FRESH_SEC)
    .sort((a, b) => age(b) - age(a))
    .slice(0, REFRESH_BUDGET);

  if (due.length === 0) return { ok: 0, failures: [] };

  const settled = await Promise.allSettled(due.map((sym) => fetchUnder(sym, nowSec)));
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

  if (failures.length) console.error(`[/api/basis] yahoo: ${failures.join(" | ")}`);
  return { ok, failures };
}

/** Memoised quotes young enough to price against. Anything older is dropped. */
function usableUnderlyings(nowSec: number): Map<string, UnderQuote> {
  const usable = new Map<string, UnderQuote>();
  for (const [sym, q] of underCache) {
    if (nowSec - q.fetchedAt <= UNDER_MAX_AGE_SEC) usable.set(sym, q);
    else underCache.delete(sym);
  }
  return usable;
}

// ---- handler --------------------------------------------------------------

const fail = (
  body: { pairs: BasisPair[]; unresolved: Unresolved[]; error: string },
  sources: { jupiter: boolean; yahoo: boolean },
  status: number,
) =>
  NextResponse.json<Body>(
    { ...body, sources, fetchedAt: new Date().toISOString() },
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
      { pairs: [], unresolved: allUnresolved(error), error },
      { jupiter: false, yahoo: false },
      operational ? (e as UpstreamError).status : 500,
    );
  }

  const yahoo = await refreshUnderlyings(nowSec);
  const under = usableUnderlyings(nowSec);
  const { pairs, unresolved } = buildBasisPairs(jup, under, nowSec);

  // Every attempt this request failed, or we were still in a 429 cooldown and
  // made none. Cached rows may still render, but the leg is down and the UI
  // gets told so rather than inferring health from a non-empty table.
  const yahooDown = yahoo.ok === 0 && yahoo.failures.length > 0;

  if (pairs.length === 0) {
    const error =
      `No basis rows could be built: Jupiter returned ${jup.size} tokens, ` +
      `Yahoo yielded ${under.size} usable underlyings` +
      (yahoo.failures.length ? `. Last Yahoo errors: ${yahoo.failures.join(" | ")}` : ".");
    console.error(`[/api/basis] ${error}`);
    return fail(
      { pairs: [], unresolved: unresolved.length ? unresolved : allUnresolved(error), error },
      { jupiter: true, yahoo: false },
      502,
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
      // False while the underlying leg is failing, even though memoised rows
      // still render. Each row says which it got: a quote older than
      // UNDER_FRESH_SEC is labelled `yahoo:cached`, never `yahoo`.
      yahoo: under.size > 0 && !yahooDown,
    },
    unresolved,
    fetchedAt: new Date().toISOString(),
  });
}
