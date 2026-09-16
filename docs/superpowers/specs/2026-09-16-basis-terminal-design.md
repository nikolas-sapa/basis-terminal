# Basis — tokenized stock dispersion terminal

Stocklana hackathon (Solana Foundation). Solo build. Plan against **Fri 18 Sep 4:00pm ET**.
Target bounties: Tessera ($6k), PreStocks ($5k), Pyth, main track.

## Problem

Every tokenized stock on Solana trades at a price that is not the real price. AAPLX is not
AAPL. A PreStocks SPACEX token is currently 21.7% below its own stated NAV. Nobody surfaces
the gap, and for pre-IPO names nobody even documents where the reference price comes from.

**User:** someone holding or considering tokenized equity exposure on Solana who wants to know
whether they are paying a premium before they buy.

## The honest split

The product has two tiers and they are NOT the same thing. Conflating them would be wrong and
a judge who knows this space would catch it.

**Tier 1 — tradeable basis (listed equities).** xStocks/Ondo token vs its underlying equity,
both from Pyth. The gap is real, live, and actionable. Gets a swap button.

**Tier 2 — relative value (pre-IPO).** PreStocks token vs its own NAV mark, and cross-venue
implied-valuation spread between Tessera and PreStocks. Verified: no conversion path between
venues (separate issuers, separate Cayman SPVs, separate mints, no burn-and-mint, no forced
convergence date, different share fractions so no hedge ratio). **No swap button, ever.**

## Verified data sources

| Source | Endpoint | Status |
|---|---|---|
| Pyth Hermes | `https://hermes.pyth.network/v2/price_feeds` | 1,895 feeds, no auth |
| PreStocks | `https://prestocks.com/api/prestocks` | 8 cos, no auth, live |
| Tessera | `https://rest-api.tessera.pe/v1/public/token-details` | 3 cos, no auth, **static** |

**Pyth pairs:** 33 raw symbol matches, ~18 legitimate after dropping false positives
(`Crypto.TON`=Toncoin not AT&T, `CFX`=Conflux, `GMX`, `LION`). Confirmed good: AAPL, AMZN,
COIN, CRCL, GOOGL, HOOD, META, MSFT, MSTR, NVDA, TSLA (X and ON variants), plus SPY, QQQ, GLD,
NFLX, MCD, MU. **A hardcoded allowlist, not a regex.** The regex is what produced the garbage.

**Provenance, to be shown in UI:** Tessera markPrice is hand-set and did not move across
repeated fetches; its own proof-of-reserve publishes asset *counts*, explicitly "not dollar
valuations," attested ~monthly. PreStocks markPrice is machine-updated from an unstated source.
Neither documents methodology. Say so on screen.

**Liveness is per-token.** PreStocks `tokenPrice` moves for SpaceX/OpenAI/Neuralink but was
byte-identical across polls for Anduril, Figure AI, Kalshi, Polymarket. Those four move only
because the mark moves. Each row carries a liveness badge; a static token is never drawn as a
live tick.

## Screens

Single page, three sections.

1. **Basis table (Tier 1).** Per pair: token price, underlying price, basis in bps, rich/cheap
   verdict, NYSE session state. Sorted by absolute basis. Row expands to the Jupiter Plugin
   pre-filled with that pair's mints.
2. **Pre-IPO premium (Tier 2).** Per PreStocks token: mark, token price, premium %, liveness
   badge. No action.
3. **Cross-venue (Tier 2).** The 3 names on both Tessera and PreStocks, compared on implied
   valuation only, explicitly labeled relative value with a one-line reason why it is not arb.

## Architecture

Next.js App Router on Vercel. All three APIs fetched **server-side** in route handlers, so CORS
is moot and keys stay server-side if any appear later. Client polls own routes.

- `app/api/pyth/route.ts` — allowlist -> Hermes -> `{pairs: [{sym, tokenPx, underPx, bps, marketOpen}]}`
- `app/api/preipo/route.ts` — PreStocks + Tessera -> normalized rows + liveness + provenance
- `lib/basis.ts` — pure math: bps, premium, verdict, staleness. Zero IO. This is what gets tested.
- `app/page.tsx` — three sections, server components + client poller
- Jupiter Plugin mounted client-side only, `initialInputMint`/`initialOutputMint` from the row

Design DNA: Geist Sans, accent `#006bff`, no orange, no emoji, icons only.

## Test plan (lands before implementation)

| # | Test | Pass criteria |
|---|---|---|
| T1 | Pyth route returns pairs | >= 15 pairs, p95 < 2000ms, zero false-positive symbols |
| T2 | Market-closed detection | Equity feed older than 15 min during a known-closed window -> `marketOpen:false` |
| T3 | Basis math | Known inputs: 234.11 vs 232.80 -> +56 bps (+/- 1); negative and zero cases |
| T4 | Staleness | Identical tokenPrice across 3 consecutive polls -> row flagged stale |
| T5 | Jupiter pre-fill | Plugin mounts with `initialOutputMint` equal to the clicked row's mint |
| T6 | **Honesty guard** | No swap control renders on ANY Tier 2 row. Fails the build if one does. |

T6 is the guard that keeps the product honest under time pressure. It must be able to fail:
add a swap button to a Tier 2 row once and confirm red before trusting green.

## Non-goals

- No custom wallet adapter, no transaction signing, no custom swap routing. Jupiter Plugin only.
- No order book, no lending, no yield, no portfolio tracking, no auth, no database.
- No historical charts. Live snapshot plus session state only.
- No Meteora DBC pool, no token launch, no on-chain program. Nothing requiring Rust or capital.
- No arbitrage claim on pre-IPO. Relative value only.
- No mobile-native app.

## Open risks

1. **xStock mint addresses.** Pyth gives feed IDs, not Solana mints. Jupiter needs mints for
   pre-fill. Resolve from the Jupiter token list API or Backed Finance docs at build time.
   If unresolvable for a symbol, that row degrades to read-only rather than shipping a broken
   button.
2. **Deadline unresolved.** Rules text says Sep 18, countdown says Sep 25. Building for Sep 18.
3. **Multi-bounty eligibility unconfirmed.** Whether one submission can claim several tracks.
4. **Fallback.** If the Plugin fights us, drop to a jup.ag deep link. Tier 1 keeps its action,
   we lose in-app swap. Decision point: Thursday morning.

---

## Amendment, 2026-09-16: mint resolution and the liquidity floor

Resolving mints turned up two things that change the product, plus one near-miss.

### The near-miss: symbol search returns scam tokens

Querying Jupiter's token search for the uppercase xStock tickers (`AAPLX`,
`TSLAX`, `NVDAX`, ...) returned a pump.fun impostor for **every single one**:
"Apple" at `2PdabVsS...pump` with $2,432 liquidity, plus "Amazonian Coin",
"Google Employee", "SPY X SPY", "ChainHood", "MacroStrategy". All had
`organicScore: 0`, none were verified, all had roughly $2-3k of depth.

Wiring any of those into the swap widget would have sent a user's funds to a
scam token while the UI displayed Apple's real price beside it. This is the
worst failure this product could ship, and symbol search is what produced it.

**Authentic xStocks use a lowercase `x` suffix** (`AAPLx`) and mints on the `Xs`
vanity prefix, with liquidity in the hundreds of thousands. Pyth independently
names its feeds in uppercase (`Crypto.AAPLX/USD`), so symbol case does not
carry between the two systems and must be mapped explicitly.

Mints now live in `lib/mints.ts`, resolved from Jupiter's verified-tag list
filtered on both the name suffix and the `Xs` mint prefix. `lib/mints.test.ts`
guards it: mints must be `Xs`-prefixed, must not contain "pump", tickers must be
lowercase-`x`, and addresses must be unique. Verified failable by injecting the
real scam address, which turns two tests red.

### Finding 1: only 21 of 839 xStocks are tradeable

839 xStocks exist. 21 clear $100k of liquidity, 30 clear $10k, and **794 sit
below $1k**. A swap control on a $200-depth token is not a trade, it is a rug by
slippage.

`LIQUIDITY_FLOOR_USD = 100_000`. Below it, a row still shows its basis but is
offered no action. Of the allowlist, 14 of 15 clear the floor; NFLXx at $3,302
does not and ships read-only. This distinction between "mispriced" and
"mispriced and actually tradeable" is what separates this from a toy.

### Finding 2: Ondo is not tradeable at all

All 436 Ondo tokenized equities are effectively illiquid on Solana DEXs:
NVDAon $491, AMDon $945, CRCLon $209, HOODon $0. Pyth carries `Crypto.<SYM>ON`
feeds, so their basis is worth displaying, but no Ondo row may render a swap
control. `ONDO_TRADEABLE = false`, and no Ondo mint is recorded, so there is
nothing for a UI task to accidentally wire up.

### Plan deltas

- Task 2's `PAIRS` keeps no mint data. It imports from `lib/mints.ts` instead.
- Task 4 renders an action control only when `isTradeable(mint)` is true, and
  shows the liquidity figure on every row so a user can see the depth behind a
  quoted basis.
- Task 6's swap panel takes its mint from `mintFor(sym)`, never from a symbol
  lookup, and the T6 honesty guard extends to assert that no component resolves
  a mint by symbol search.
