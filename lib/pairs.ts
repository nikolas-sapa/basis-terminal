import { bps, verdict } from "./basis.ts";

export type PairDef = { sym: string; tokenSym: string; mint: string | null };

// ponytail: hardcoded, not regex-matched. Regexing Pyth symbols yielded
// Crypto.TON (Toncoin) as tokenized AT&T and Crypto.CFX (Conflux) as CF.
// Every tokenSym below was confirmed present in GET /v2/price_feeds.
export const PAIRS: PairDef[] = [
  { sym: "AAPL",  tokenSym: "AAPLX",  mint: null },
  { sym: "TSLA",  tokenSym: "TSLAX",  mint: null },
  { sym: "NVDA",  tokenSym: "NVDAX",  mint: null },
  { sym: "MSFT",  tokenSym: "MSFTX",  mint: null },
  { sym: "GOOGL", tokenSym: "GOOGLX", mint: null },
  { sym: "AMZN",  tokenSym: "AMZNX",  mint: null },
  { sym: "META",  tokenSym: "METAX",  mint: null },
  { sym: "COIN",  tokenSym: "COINX",  mint: null },
  { sym: "HOOD",  tokenSym: "HOODX",  mint: null },
  { sym: "MSTR",  tokenSym: "MSTRX",  mint: null },
  { sym: "CRCL",  tokenSym: "CRCLX",  mint: null },
  { sym: "SPY",   tokenSym: "SPYX",   mint: null },
  { sym: "QQQ",   tokenSym: "QQQX",   mint: null },
  { sym: "GLD",   tokenSym: "GLDX",   mint: null },
  { sym: "NFLX",  tokenSym: "NFLXX",  mint: null },
];

export const pythSymbol = (p: PairDef) => ({
  under: `Equity.US.${p.sym}/USD`,
  token: `Crypto.${p.tokenSym}/USD`,
});

export type Pair = {
  sym: string;
  tokenSym: string;
  tokenPx: number;
  underPx: number;
  bps: number;
  verdict: string;
  marketOpen: boolean;
  mint: string | null;
};

export type Wanted = { p: PairDef; underId: string; tokenId: string };

/** A `parsed[]` entry of Hermes `GET /v2/updates/price/latest`. `price` and
 *  `conf` are strings (serde `as_string`); `expo` and `publish_time` are
 *  numbers. Verified against apps/hermes/server/src/api/types.rs. */
export type ParsedPriceUpdate = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
};

// ponytail: Hermes serialises a price id as bare lowercase hex on BOTH
// /v2/price_feeds and the `parsed[].id` of /v2/updates/price/latest
// (RpcPriceIdentifier is `#[serde(with = "hex")] [u8; 32]`). Normalising on
// both sides anyway: a one-sided strip silently empties the lookup map and
// every row vanishes if either endpoint ever starts emitting a 0x prefix.
export const normId = (id: string) => id.replace(/^0x/i, "").toLowerCase();

/** Seconds after which an equity feed is treated as a last close, not a tick. */
export const STALE_SECONDS = 900;

export function buildPairs(
  wanted: Wanted[],
  parsed: ParsedPriceUpdate[],
  nowSec: number,
): Pair[] {
  const px = new Map<string, { v: number; t: number }>();
  for (const e of parsed) {
    // expo is negative (-8 on these feeds), so this scales down.
    px.set(normId(e.id), {
      v: Number(e.price.price) * 10 ** e.price.expo,
      t: e.price.publish_time,
    });
  }

  return wanted
    .flatMap((w) => {
      const u = px.get(normId(w.underId));
      const t = px.get(normId(w.tokenId));
      if (!u || !t || !Number.isFinite(u.v) || !Number.isFinite(t.v)) return [];
      const b = bps(t.v, u.v);
      return [{
        sym: w.p.sym,
        tokenSym: w.p.tokenSym,
        mint: w.p.mint,
        tokenPx: t.v,
        underPx: u.v,
        bps: b,
        verdict: verdict(b),
        marketOpen: nowSec - u.t < STALE_SECONDS,
      }];
    })
    .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));
}
