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
