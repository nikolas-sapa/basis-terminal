import { premium } from "./basis.ts";

export type PreStocksRaw = {
  name: string;
  symbol: string;
  contract_address: string;
  markPrice: number;
  markValuation: number;
  tokenPrice: number;
  impliedValuation: number;
  supply: number;
};

export type TesseraRaw = {
  symbol: string;
  mint: string;
  markPrice: number;
  markValuation: number;
};

export type PreIpoRow = {
  company: string;
  symbol: string;
  markPx: number;
  tokenPx: number;
  premiumPct: number;
  mint: string;
  venue: "prestocks";
};

export type CrossRow = {
  company: string;
  tesseraValuation: number;
  prestocksValuation: number;
  spreadPct: number;
};

export const TESSERA_NAME_MAP: Record<string, string> = {
  "T-OpenAI": "OpenAI",
  "T-Kalshi": "Kalshi",
  "T-SpaceX": "SpaceX",
};

const company = (r: PreStocksRaw) => r.name.replace(/ PreStocks$/, "");

export function normalizePreStocks(raw: PreStocksRaw[]): PreIpoRow[] {
  return raw.map((r) => ({
    company: company(r),
    symbol: r.symbol,
    markPx: r.markPrice,
    tokenPx: r.tokenPrice,
    premiumPct: premium(r.tokenPrice, r.markPrice),
    mint: r.contract_address,
    venue: "prestocks" as const,
  }));
}

// ponytail: valuation-only comparison. Raw prices are NOT comparable across
// venues (different share fractions) and the tokens are not convertible, so
// this is relative value, never arbitrage. No price or mint is returned here
// on purpose, so no caller can wire a swap button to it.
//
// markValuation on BOTH sides, deliberately. PreStocks publishes two: its
// markValuation moves with markPrice (the venue's reference mark) and its
// impliedValuation moves with tokenPrice (what the token actually trades at) --
// verified, the two ratios agree to ~1e-12 on all 8 tokens. Tessera publishes
// only a hand-set mark valuation and has no traded-price equivalent, so
// mark-to-mark is the one like-for-like read. Pairing Tessera's mark against
// PreStocks' impliedValuation would compare a hand-set number to a live market
// price and dress the difference up as a dislocation.
export function crossVenue(ps: PreStocksRaw[], te: TesseraRaw[]): CrossRow[] {
  const psBy = new Map(ps.map((r) => [company(r), r]));
  return te.flatMap((t) => {
    const name = TESSERA_NAME_MAP[t.symbol];
    const p = name ? psBy.get(name) : undefined;
    if (!p || !t.markValuation) return [];
    return [{
      company: name,
      tesseraValuation: t.markValuation,
      prestocksValuation: p.markValuation,
      spreadPct: (p.markValuation / t.markValuation - 1) * 100,
    }];
  });
}
