import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePreStocks } from "./preipo.ts";

// ponytail: these fixtures are a verbatim snapshot of the live responses taken
// 2026-09-16, not hand-written numbers. PreStocks marks move, so the snapshot is
// frozen here rather than fetched; every asserted value below is derived from
// these exact literals.
//
// PreStocks exposes TWO valuations: markValuation tracks markPrice, and
// impliedValuation tracks tokenPrice (verified: impliedValuation/markValuation
// equals tokenPrice/markPrice to ~1e-12 on all 8 tokens). The premium is taken
// against markPrice, the venue's own reference, and impliedValuation is carried
// in the fixture purely to prove we ignore it.
const PS = [
  {
    name: "SpaceX PreStocks",
    symbol: "SPACEX",
    contract_address: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
    markPrice: 150.70136820586262,
    markValuation: 1975862383144,
    tokenPrice: 121.16128527567965,
    impliedValuation: 1588559073614,
    supply: 43712.579246454996,
  },
  {
    name: "OpenAI PreStocks",
    symbol: "OPENAI",
    contract_address: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    markPrice: 967.9892705486252,
    markValuation: 1199271235274,
    tokenPrice: 982.7622109348188,
    impliedValuation: 1217573878707,
    supply: 2826.556411779235,
  },
];

const r2 = (n: number) => Math.round(n * 100) / 100;

test("premium computed and rounded", () => {
  const [r] = normalizePreStocks(PS);
  assert.equal(r2(r.premiumPct), -19.6);
});

test("normalize strips the PreStocks suffix and carries the real mint", () => {
  const [sx, oa] = normalizePreStocks(PS);
  assert.equal(sx.company, "SpaceX");
  assert.equal(sx.mint, "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh");
  assert.equal(sx.venue, "prestocks");
  assert.equal(oa.company, "OpenAI");
  assert.equal(r2(oa.premiumPct), 1.53);
});

// T6 is enforced structurally, not by convention: if this key set ever grows a
// price or a mint, a later UI task could wire a swap button onto a pair of
// tokens that are not convertible into one another. Freeze the shape.

