# Basis

Every tokenized stock on Solana trades at a price that is not the real price. AAPLx is not AAPL. A PreStocks SPACEX token currently sits well below its own stated NAV. Basis shows the gap, live, and lets you act on it where acting is actually possible.

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

**Verified mints only.** Resolving mints by symbol search returns pump.fun impostors for *every* uppercase xStock ticker. `AAPLX` yields a token literally named "Apple" at `2PdabVsS…pump` with ~$2.4k of liquidity and an organic score of zero. Authentic xStocks use a lowercase `x` suffix and mints on an `Xs` prefix. Mints are matched by address, never by symbol, and guard tests reject any address that isn't `Xs`-prefixed.

**Liquidity floor.** 839 xStocks exist; 21 clear $100k of liquidity and 794 sit under $1k. A swap control on a $200-depth token is a rug by slippage, not a trade. Below the floor a row still shows its basis but is offered no action, and every row displays its depth.

**Per-token liveness.** Four of eight PreStocks tokens don't actually trade; their premium moves only because the mark moves. Each row is badged accordingly rather than drawn as a live tick.

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
