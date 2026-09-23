# Stocklana submission — copy/paste

---

## Project name

```
Basis
```

---

## One-liner (280 max — this is 245)

```
Every tokenized stock on Solana trades at a price that isn't the price of the thing it tracks. Basis shows that gap live, splits it into the part a trade can actually capture and the part it can't, and only offers a swap where a real one exists.
```

---

## Detailed description (5000 max — this is 4,977)

```
THE PROBLEM

AAPLx is not AAPL. A PreStocks OpenAI token is not OpenAI stock. Every tokenized equity on Solana trades at some distance from the thing it represents, and nothing tells you how far. Existing interfaces show you a price and a buy button. They do not tell you whether that price is 20 basis points off the real share or 200, whether the gap is capturable or an artifact, or whether the pool behind the button has enough depth for your order to survive contact with it.

Basis is a terminal for exactly that question.

WHAT IT DOES

Two surfaces, deliberately separated, because conflating them would mislead someone about money.

Tier 1, listed equities. Fifteen xStocks against their underlying shares, refreshed every 45 seconds. Each row shows the token price, the real equity price, the gap in basis points, the DEX depth behind the token, the market session, and a Jupiter swap pre-filled in the correct direction.

Tier 2, pre-IPO. Eight PreStocks tokens against that venue's own NAV mark, with the premium or discount to mark, a per-token liveness badge, and stated provenance. These rows carry no trade button, ever. The mark is a reference the operator publishes, not a second venue you can settle against, so there is nothing to arbitrage and the product says so rather than implying otherwise.

WHAT MAKES IT DIFFERENT

The basis is two things added together, and only one is tradeable. An xStock is a wrapper: the issuer publishes its own NAV, and the pool trades around that NAV. So a DEX-vs-equity gap is pool drift plus issuer tracking error. Only pool drift is capturable by a swap. Basis splits them on every row.

This is not cosmetic. On a live reading, GOOGL's combined basis was -9 bps and looked like nothing; split apart, the pool sat 46 bps under NAV while the issuer sat 38 over the share, and the halves nearly cancelled. A single number hid a real dislocation. GLDx was the reverse: the issuer tracked the share exactly while the pool sat 2.9% below it, so the entire gap was capturable. Which half dominates depends on the session. In market hours pool drift carries the gap (38 bps against 18 on one reading). With the market closed it inverts, because the real share price is a frozen last close while the issuer keeps marking: a pre-market reading showed 56 bps of tracking error against 30 of pool drift, with COIN alone at -138. Neither regime is tradeable the same way, and one number cannot tell you which you are in.

Resolving mints by symbol is how people lose money. Searching Jupiter's unverified index for the uppercase tickers returns a pump.fun impostor for every single xStock: AAPLX yields a token literally named "Apple" at 2PdabVsS...pump with $2.4k of liquidity. Restricting to the verified set removes those but introduces a subtler trap, because 92 symbols are duplicated inside it and three verified tokens answer to some case of "META". Basis matches on mint address from a committed allowlist and never on symbol, with guard tests that reject any address off the authentic prefix.

A liquidity floor, because 1,028 xStocks exist and only 21 clear $100k of depth. A week earlier it was 839 against the same 21, so issuance grew 23% while tradeable depth did not. A swap control on a $200-depth token is a rug by slippage, not a trade. Below the floor a row still shows its basis and is offered no action, with the reason stated. The check runs against live depth, so a drained pool closes the button without a redeploy.

Every number names its upstream, and a cached read says so. An early version paired a ten-minute-old token price against a 45-second-old equity price and produced a table that read convincingly and was wrong: mean -69 bps, one row at -215. The sign was flipping on 9 of 15 rows. The tell was the distribution, not any single row, because thirteen of fifteen negative into a rising market is one leg lagging rather than fifteen simultaneous opportunities. It is fixed, and the story is in the README because it is the most useful thing we learned.

WHY SOLANA

The asset only exists here. xStocks and PreStocks tokens are SPL tokens with real DEX depth, and the swap routes through Jupiter against live pools. The most interesting reading comes on weekends: NYSE is shut, the underlying is frozen at Friday's close, and the tokens keep trading. The basis widens, visibly, because a 24/7 venue is tracking a 9:30-to-4 one. That is the actual argument for tokenized equities, and you can watch it happen.

EXECUTION

Next.js on Vercel. No key required to use it. Every upstream fetched server-side. 129 tests via the Node standard library, no test framework installed, and each guard verified failable by mutation rather than merely passing. No route can return HTTP 200 with an empty table, because a clean empty table is the worst failure a price display can have. Fully usable on a phone.

Open-source components: Next.js, React, and Jupiter's hosted swap plugin. Everything else is original.
```

---

## Links

| Field | Value |
|---|---|
| GitHub | `https://github.com/nikolas-sapa/basis-terminal` |
| Live demo | `https://basis-terminal.vercel.app` |
| Video | none yet — optional, see note |

---

## Bounty tracks — select PreStocks only

**PreStocks** is the one genuine fit, and it is now eligible: the Tessera integration was removed specifically because that bounty excludes projects integrating non-PreStocks pre-IPO tokens.

Do not select the others:

- **Tessera** — removed by choice to qualify for the larger PreStocks pool.
- **Clawpump** — requires launching a token with a stock-paired pool via Clawpump and Meteora. Not done.
- **Meteora** — requires a DBC configuration. Not done.
- **Pyth** — the integration is built, hardened and tested, but the account holds no equity or crypto-spot grants, so it returns 503 and powers nothing live. That track is judged on how central Pyth data is to the product. A judge clicking through would find it dark.

The $100k main track is not a bounty selection and applies automatically.

---

## Optional: a video would help

Not required, since GitHub and a live demo each satisfy the link rule. But the two strongest things about this project are hard to see in a static page: the basis decomposition changing what a row means, and the weekend widening when NYSE is shut. A 60-second Loom walking those two would carry more than any paragraph above.

Suggested shape:
1. Open the live table. Point at one row: token price, real price, gap.
2. Point at the vs-NAV column. Explain that only that half is capturable, using whichever row currently shows the halves disagreeing.
3. Scroll to a row below the liquidity floor and read the no-action reason aloud.
4. Scroll to Tier 2. Note there is no button, and say why.
5. Click one Buy. Show the Jupiter panel opening pre-filled with the right pair.
