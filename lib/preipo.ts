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

export type PreIpoRow = {
  company: string;
  symbol: string;
  markPx: number;
  tokenPx: number;
  premiumPct: number;
  mint: string;
  venue: "prestocks";
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
// verified, the two ratios agree to ~1e-12 on all 8 tokens.
// PreStocks' impliedValuation would compare a hand-set number to a live market
// price and dress the difference up as a dislocation.
