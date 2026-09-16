// Verified tokenized-equity mints. Resolved 2026-09-16 from Jupiter's
// verified-tag list, filtered to name ending " xStock" AND mint on the `Xs`
// vanity prefix, then cross-checked against reported DEX liquidity.
//
// SAFETY, READ BEFORE EDITING:
// Do NOT resolve these by symbol search. Searching Jupiter for the uppercase
// tickers (AAPLX, TSLAX, ...) returns pump.fun impostors squatting the ticker:
// "Apple" at 2PdabVsS...pump with $2.4k liquidity, "Amazonian Coin", "Google
// Employee", "SPY X SPY", all organicScore 0, none verified. Wiring one of
// those into a swap sends a user's funds to a scam token. Authentic xStocks
// use a LOWERCASE x suffix and an `Xs` mint prefix. Pyth, separately, names
// its feeds in uppercase (Crypto.AAPLX/USD), so symbol case does not carry
// across systems: map it explicitly, never infer it.

export type Mint = {
  /** Underlying equity ticker, matches Pyth's Equity.US.<sym>/USD */
  sym: string;
  /** Jupiter ticker, lowercase x suffix */
  tokenSym: string;
  mint: string;
  /** Reported DEX liquidity in USD at resolution time */
  liquidityUsd: number;
};

/**
 * Minimum DEX liquidity before a swap control is offered.
 *
 * Of 839 existing xStocks only 21 clear $100k; 794 sit below $1k. Offering a
 * swap on a $200-depth token is not a trade, it is a rug by slippage. Rows
 * below this floor still display their basis, they just get no action.
 */
export const LIQUIDITY_FLOOR_USD = 100_000;

export const MINTS: Mint[] = [
  { sym: "SPY",   tokenSym: "SPYx",   mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", liquidityUsd: 4_893_997 },
  { sym: "NVDA",  tokenSym: "NVDAx",  mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", liquidityUsd: 1_860_544 },
  { sym: "QQQ",   tokenSym: "QQQx",   mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", liquidityUsd: 1_705_125 },
  { sym: "CRCL",  tokenSym: "CRCLx",  mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", liquidityUsd: 1_332_633 },
  { sym: "TSLA",  tokenSym: "TSLAx",  mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", liquidityUsd: 1_240_777 },
  { sym: "HOOD",  tokenSym: "HOODx",  mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", liquidityUsd:   728_863 },
  { sym: "AAPL",  tokenSym: "AAPLx",  mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", liquidityUsd:   714_996 },
  { sym: "MSTR",  tokenSym: "MSTRx",  mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", liquidityUsd:   708_740 },
  { sym: "GLD",   tokenSym: "GLDx",   mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", liquidityUsd:   489_553 },
  { sym: "MSFT",  tokenSym: "MSFTx",  mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", liquidityUsd:   463_769 },
  { sym: "GOOGL", tokenSym: "GOOGLx", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", liquidityUsd:   414_716 },
  { sym: "META",  tokenSym: "METAx",  mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", liquidityUsd:   325_342 },
  { sym: "COIN",  tokenSym: "COINx",  mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", liquidityUsd:   262_429 },
  { sym: "AMZN",  tokenSym: "AMZNx",  mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", liquidityUsd:   188_775 },
  // Below the floor: basis shown, no swap offered.
  { sym: "NFLX",  tokenSym: "NFLXx",  mint: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL", liquidityUsd:     3_302 },
];

/** USDC, the quote leg for every swap. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const mintFor = (sym: string): Mint | undefined =>
  MINTS.find((m) => m.sym === sym);

export const isTradeable = (m: Mint): boolean =>
  m.liquidityUsd >= LIQUIDITY_FLOOR_USD;

/**
 * Ondo's tokenized equities (Pyth's Crypto.<SYM>ON/USD feeds) are deliberately
 * absent. All 436 of them are effectively illiquid on Solana DEXs: NVDAon $491,
 * AMDon $945, HOODon $0, CRCLon $209. Their Pyth basis is worth displaying, but
 * no swap control may be offered on them, so no mint is recorded here.
 */
export const ONDO_TRADEABLE = false;
