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

export function normalizePreStocks(raw: unknown): PreIpoRow[] {
  if (!Array.isArray(raw)) throw new Error("PreStocks response must be an array");
  return raw.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`PreStocks row ${index} must be an object`);
    }
    const r = entry as Record<string, unknown>;
    if (
      typeof r.name !== "string" || !r.name.trim() ||
      typeof r.symbol !== "string" || !r.symbol.trim() ||
      typeof r.contract_address !== "string" || !r.contract_address.trim()
    ) {
      throw new Error(`PreStocks row ${index} needs a name, symbol and mint`);
    }
    const company = r.name.replace(/ PreStocks$/, "");
    if (!company.trim()) throw new Error(`PreStocks row ${index} has an empty company`);
    if (
      typeof r.markPrice !== "number" || !Number.isFinite(r.markPrice) || r.markPrice <= 0 ||
      typeof r.tokenPrice !== "number" || !Number.isFinite(r.tokenPrice) || r.tokenPrice < 0
    ) {
      throw new Error(`PreStocks row ${index} has invalid reference or token prices`);
    }
    const premiumPct = premium(r.tokenPrice, r.markPrice);
    if (!Number.isFinite(premiumPct)) throw new Error(`PreStocks row ${index} has a non-finite premium`);
    return {
      company,
      symbol: r.symbol,
      markPx: r.markPrice,
      tokenPx: r.tokenPrice,
      premiumPct,
      mint: r.contract_address,
      venue: "prestocks" as const,
    };
  });
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
