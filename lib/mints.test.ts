import { test } from "node:test";
import assert from "node:assert/strict";
import { MINTS, USDC_MINT, LIQUIDITY_FLOOR_USD, isTradeable, mintFor } from "./mints.ts";

// These guards encode a near-miss. Resolving these mints by Jupiter symbol
// search returned pump.fun impostors ("Apple" at 2PdabVsS...pump, $2.4k
// liquidity, organicScore 0) for every single ticker. Wiring one into a swap
// would have sent real funds to a scam token. If a future edit reintroduces a
// symbol-search-derived address, these tests are what catch it.

test("every mint is on the authentic xStock Xs prefix", () => {
  for (const m of MINTS) {
    assert.ok(m.mint.startsWith("Xs"), `${m.sym}: ${m.mint} is not an Xs-prefix mint`);
  }
});

test("no mint is a pump.fun launch", () => {
  for (const m of MINTS) {
    assert.ok(!m.mint.toLowerCase().includes("pump"), `${m.sym}: ${m.mint} looks like a pump.fun token`);
  }
});

test("token symbols use the authentic lowercase x suffix", () => {
  for (const m of MINTS) {
    assert.ok(m.tokenSym.endsWith("x"), `${m.tokenSym} must end in lowercase x`);
    assert.ok(!m.tokenSym.endsWith("X"), `${m.tokenSym} uppercase X is the squatter convention`);
  }
});

test("mints are unique, no symbol aliases onto another's address", () => {
  const seen = new Set(MINTS.map((m) => m.mint));
  assert.equal(seen.size, MINTS.length, "duplicate mint address across symbols");
});

test("USDC quote leg is the canonical mainnet mint", () => {
  assert.equal(USDC_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});

test("tradeable set respects the liquidity floor", () => {
  const tradeable = MINTS.filter(isTradeable);
  assert.ok(tradeable.length >= 10, `only ${tradeable.length} tradeable`);
  for (const m of tradeable) assert.ok(m.liquidityUsd >= LIQUIDITY_FLOOR_USD);
});

test("NFLX is below the floor and therefore not tradeable", () => {
  const nflx = mintFor("NFLX");
  assert.ok(nflx, "NFLX missing");
  assert.equal(isTradeable(nflx), false, "NFLXx has $3.3k liquidity, a swap there is a rug by slippage");
});

test("every Pyth-side symbol is uppercase, since Pyth names feeds in caps", () => {
  for (const m of MINTS) assert.equal(m.sym, m.sym.toUpperCase());
});
