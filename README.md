# Basis

Every tokenized stock on Solana trades at a price that is not the real price. AAPLx is not AAPL. A PreStocks SPACEX token currently sits well below its own stated NAV. Basis shows the gap, live, and lets you act on it where acting is actually possible.

**Live: https://basis-terminal.vercel.app**

Built for [Stocklana](https://hackathons.solana.com) (Solana Foundation).

## The two tiers are not the same thing

This distinction is the product, and conflating the two would be misleading.

**Tier 1 — tradeable basis (listed equities).** An xStock token's on-chain price against its underlying equity. The gap is real, live, and actionable. These rows get a swap control, routed through Jupiter.

**Tier 2 — relative value (pre-IPO).** A PreStocks token against its own NAV mark, plus the implied-valuation spread between Tessera and PreStocks for names listed on both. **No swap control, ever.** These tokens are issued by separate entities into separate Cayman SPVs, are not convertible into one another, have no date on which their prices must converge, and represent different fractions of a share so there isn't even a hedge ratio. Calling that arbitrage would be wrong.

That constraint is enforced in code, not by convention: `crossVenue()` returns rows carrying no mint and no price, and a test asserts the exact key set so a swap button cannot be wired to Tier 2 data even by accident.

## Data sources

| Source | What it provides | Keyless |
|---|---|---|
| Jupiter | On-chain token price, liquidity, verified mint | Yes |
| Yahoo Finance | Underlying equity price | Yes |
| PreStocks | Pre-IPO mark and traded price, 8 companies | Yes |
| Tessera | Pre-IPO reference mark, 3 companies | Yes |
| Pyth | Underlying equity price for TSLA and QQQ | Requires entitled key |

Pyth is a labeled enhancement, not a dependency. Public Hermes closed on 2026-08-26 and now requires an API key; a free trial grants 3 equity feeds and **zero** tokenized feeds, so Pyth cannot produce a complete basis row on its own. The keyless path serves all pairs and does not expire.

## Honesty features

These exist because the alternative is a product that quietly misleads people about money.

**Verified mints only, matched by address.** Two separate hazards make this mandatory.

Searching Jupiter's *unverified* index for the uppercase tickers returns pump.fun impostors for every one: `AAPLX` yields a token literally named "Apple" at `2PdabVsS…pump`, ~$2.4k liquidity, organic score zero.

Restricting to the verified set removes those, but introduces a subtler problem: **92 symbols are duplicated within it, and three verified tokens answer to some case of "META"** — MetaDAO at $4.53, a token named META at $4,564, and METAx at $673. Picking by symbol there is a coin flip with someone's money.

So mints are resolved by address from a committed allowlist, never by symbol lookup, and guard tests reject any address that isn't `Xs`-prefixed. Authentic xStocks use a lowercase `x` suffix; Pyth names the same assets in uppercase, so case carries no meaning across systems.

**Liquidity floor.** 839 xStocks exist; 21 clear $100k of liquidity and 794 sit under $1k. A swap control on a $200-depth token is a rug by slippage, not a trade. Below the floor a row still shows its basis but is offered no action, and every row displays its depth. The check runs against live liquidity as well as the committed snapshot, so drained depth removes the swap control without a redeploy.

**Fresh prices on both legs, which is harder than it sounds.** Jupiter's verified-token list is ~5MB, so it is cached for ten minutes; the equity leg refreshes every 45 seconds. Subtracting a ten-minute-old token price from a 45-second-old equity price produces a basis that measures cache lag rather than dislocation. It read convincingly: fifteen plausible rows, mean -69 bps, NFLX at -215 bps.

It was wrong. Token prices now come from `price/v3` on a 30-second TTL, overlaid on the cached list for identity only, and the same table reads mean -13 bps with NFLX at -5. The sign had been flipping on 9 of 15 rows.

**The tell was the distribution, not any single row.** Thirteen of fifteen rows negative into a rising equity market is the signature of one leg lagging, not of fifteen simultaneous arbitrage opportunities. A uniformly-signed basis table should be disbelieved before it is traded.

And the phantom fell hardest on the thinnest token. NFLXx has the least liquidity, so it traded least often, so its cached price was stalest, so it showed the widest "opportunity." Apparent edge in an illiquid asset is usually stale data wearing a costume. That is the same instinct the liquidity floor encodes, arrived at from the opposite direction.

**Per-token liveness, with its window disclosed.** An early reading suggested four of the eight PreStocks tokens never trade. Polling properly (15 samples at 20s, plus repeat sessions) showed that was an artifact: *every* token holds a flat plateau for 60-80 seconds, and which ones look frozen depends entirely on how long you watch. So a STATIC badge is a claim about the sampling window, not about the token, and the UI states the window on screen: three polls, 45 seconds apart. A liveness indicator that hides its window is making an unfalsifiable claim.

**Stated provenance.** Neither pre-IPO venue documents where its prices come from. Tessera's own proof-of-reserve publishes asset *counts*, explicitly "not dollar valuations," attested approximately monthly. The UI says so instead of burying it.

**Market session.** An equity quote outside market hours is a last close. Rows say which they're showing.

## Running it

```bash
npm install
npm run dev
```

Optional, for the Pyth-labeled rows:

```bash
echo "PYTH_API_KEY=your_key" > .env.local
```

Tests use the Node standard library. No test framework is installed.

```bash
node --test "lib/**/*.test.ts"
```

## Notes

`tsconfig.json` sets `erasableSyntaxOnly`. Node runs `.ts` in strip-only mode, so parameter properties, enums and namespaces throw at import time under `node --test` while compiling fine under Next. The flag surfaces that at typecheck instead.

Design, spec and implementation plan, including every correction made along the way, are in `docs/superpowers/`.

## License

MIT
