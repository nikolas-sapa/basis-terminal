import { NextResponse } from "next/server";
import { PAIRS, pythSymbol, buildPairs, type ParsedPriceUpdate, type Wanted } from "@/lib/pairs";

const HERMES = "https://hermes.pyth.network";

// ponytail: Hermes stopped serving price updates anonymously on 2026-08-26
// ("Pyth Core upgrade ... Hermes now requires an API Key"). Anonymous requests
// to /v2/updates/price/latest return 401; a bad key returns 403 "Not entitled".
// The metadata endpoint /v2/price_feeds is still open, but we send the header
// on both so a later gate there does not take the route down.
const KEY = process.env.PYTH_API_KEY;

// 30 ids at ~72 chars each would put the query string past 2KB, which some
// edges truncate. 20 per request keeps it near 1.5KB.
const BATCH = 20;

// Feed ids are stable; the metadata payload is ~1MB. Refetching it on every
// 10s poll is pure waste, so memoise it per server instance.
const FEEDS_TTL_MS = 10 * 60 * 1000;
let feedCache: { at: number; bySymbol: Map<string, string> } | null = null;

export const revalidate = 0;
export const dynamic = "force-dynamic";

type Body = {
  pairs: ReturnType<typeof buildPairs>;
  sources: { pyth: boolean };
  unresolved: string[];
  fetchedAt: string;
  error?: string;
};

// ponytail: an explicit field, not a `readonly status` parameter property.
// Parameter properties are real TS syntax that Node's strip-only mode rejects,
// which would make this module unloadable by `node --test`.
class UpstreamError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const fail = (body: Omit<Body, "sources" | "fetchedAt"> & { error: string }, status: number) =>
  NextResponse.json<Body>(
    // ponytail: `sources.pyth` is false on every failure path. An empty `pairs`
    // with HTTP 200 is the worst outcome available here: the UI renders a clean
    // empty table and a dead upstream looks like a quiet market.
    { ...body, sources: { pyth: false }, fetchedAt: new Date().toISOString() },
    { status },
  );

async function getJson(url: string, what: string) {
  let r: Response;
  try {
    r = await fetch(url, {
      cache: "no-store",
      headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
    });
  } catch (e) {
    // Never swallow: a DNS/TLS/timeout failure is otherwise invisible.
    console.error(`[/api/pyth] ${what} fetch threw:`, e);
    throw new UpstreamError(`Pyth ${what} unreachable`, 502);
  }

  if (!r.ok) {
    // Surface Hermes' own reason (it names the unentitled feed) but never the key.
    const body = (await r.text().catch(() => "")).slice(0, 200);
    console.error(`[/api/pyth] ${what} HTTP ${r.status} ${r.statusText}: ${body}`);
    throw new UpstreamError(`Pyth ${what} failed: ${r.status} ${body}`.trim(), 502);
  }

  try {
    return await r.json();
  } catch (e) {
    console.error(`[/api/pyth] ${what} returned HTTP 200 with unparseable JSON:`, e);
    throw new UpstreamError(`Pyth ${what} returned malformed JSON`, 502);
  }
}

async function feedIdsBySymbol(): Promise<Map<string, string>> {
  if (feedCache && Date.now() - feedCache.at < FEEDS_TTL_MS) return feedCache.bySymbol;

  const feeds = await getJson(`${HERMES}/v2/price_feeds`, "price_feeds");

  // ponytail: a 200 carrying a JSON error object is how several APIs report
  // rate limits. `.json()` resolves, a bare `.catch` never fires, and the
  // iteration below is what finally explodes with a useless 500. Check first.
  if (!Array.isArray(feeds)) {
    console.error(
      `[/api/pyth] price_feeds returned HTTP 200 but not an array:`,
      JSON.stringify(feeds).slice(0, 300),
    );
    throw new UpstreamError("Pyth price_feeds returned an unexpected payload", 502);
  }

  const bySymbol = new Map<string, string>();
  for (const f of feeds) {
    const sym = f?.attributes?.symbol;
    if (typeof sym === "string" && typeof f?.id === "string") bySymbol.set(sym, f.id);
  }
  if (bySymbol.size === 0) {
    console.error("[/api/pyth] price_feeds parsed to zero usable feeds");
    throw new UpstreamError("Pyth price_feeds contained no usable feeds", 502);
  }

  feedCache = { at: Date.now(), bySymbol };
  return bySymbol;
}

async function latest(ids: string[]): Promise<ParsedPriceUpdate[]> {
  const out: ParsedPriceUpdate[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const qs = new URLSearchParams();
    for (const id of ids.slice(i, i + BATCH)) qs.append("ids[]", id);
    // Without this a single id Hermes no longer knows 404s the whole batch.
    qs.set("ignore_invalid_price_ids", "true");

    const res = await getJson(`${HERMES}/v2/updates/price/latest?${qs}`, "updates/price/latest");

    if (!Array.isArray(res?.parsed)) {
      console.error(
        `[/api/pyth] updates/price/latest batch ${i / BATCH} has no parsed[]:`,
        JSON.stringify(res).slice(0, 300),
      );
      throw new UpstreamError("Pyth updates/price/latest returned no parsed prices", 502);
    }
    out.push(...res.parsed);
  }
  return out;
}

export async function GET() {
  if (!KEY) {
    // Fail loud. An empty `pairs` array would render as a blank table and read
    // as "no basis today" rather than "the data source is unconfigured".
    const msg =
      "PYTH_API_KEY is not set. Hermes has required an API key since the 2026-08-26 Pyth Core upgrade. Get a free key from a Pyth Terminal account: https://docs.pyth.network/price-feeds/pro/acquire-api-key";
    console.error(`[/api/pyth] ${msg}`);
    return fail({ pairs: [], unresolved: PAIRS.map((p) => p.sym), error: msg }, 503);
  }

  try {
    const bySymbol = await feedIdsBySymbol();

    const wanted: Wanted[] = [];
    const unresolved: string[] = [];
    for (const p of PAIRS) {
      const s = pythSymbol(p);
      const underId = bySymbol.get(s.under);
      const tokenId = bySymbol.get(s.token);
      if (underId && tokenId) wanted.push({ p, underId, tokenId });
      else unresolved.push(p.sym);
    }
    if (unresolved.length) {
      console.error(`[/api/pyth] no Pyth feed for: ${unresolved.join(", ")}`);
    }

    const parsed = await latest(wanted.flatMap((w) => [w.underId, w.tokenId]));
    const pairs = buildPairs(wanted, parsed, Math.floor(Date.now() / 1000));

    // ponytail: an empty `pairs` never gets a 200. Two real paths reach here
    // with nothing: no symbol resolved at all (so `latest` never even fetched),
    // and Hermes answering with ids that line up with no pair. Both used to
    // return 200, which the UI renders as a clean empty table -- a dead
    // upstream indistinguishable from a quiet market. Fail loud instead.
    if (pairs.length === 0) {
      const msg = `Pyth returned no usable pairs: ${wanted.length} requested, ${parsed.length} price updates back`;
      console.error(`[/api/pyth] ${msg}`);
      return fail({ pairs: [], unresolved, error: msg }, 502);
    }

    return NextResponse.json<Body>({
      pairs,
      // True only when Hermes actually handed back price updates. Reported
      // separately from `pairs.length` so "upstream answered but the legs did
      // not line up" stays distinguishable from "upstream is dead".
      sources: { pyth: parsed.length > 0 },
      unresolved,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    const operational = e instanceof UpstreamError;
    // Operational paths already logged their specifics in getJson; this logs
    // the programmer errors that would otherwise vanish into a bare 500.
    if (!operational) console.error("[/api/pyth] unhandled:", e);
    return fail(
      {
        pairs: [],
        unresolved: PAIRS.map((p) => p.sym),
        error: operational ? e.message : "Internal Server Error",
      },
      operational ? (e as UpstreamError).status : 500,
    );
  }
}
