import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePreStocks, crossVenue, TESSERA_NAME_MAP } from "./preipo.ts";

// ponytail: these fixtures are a verbatim snapshot of the live responses taken
// 2026-09-16, not hand-written numbers. PreStocks marks move, so the snapshot is
// frozen here rather than fetched; every asserted value below is derived from
// these exact literals.
//
// PreStocks exposes TWO valuations: markValuation tracks markPrice, and
// impliedValuation tracks tokenPrice (verified: impliedValuation/markValuation
// equals tokenPrice/markPrice to ~1e-12 on all 8 tokens). Tessera publishes only
// a mark valuation, so mark-to-mark is the only like-for-like comparison and
// impliedValuation is carried in the fixture purely to prove we ignore it.
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

const TE = [
  { symbol: "T-OpenAI", mint: "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ", markPrice: 812.79, markValuation: 950000000000 },
  { symbol: "T-Kalshi", mint: "TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ", markPrice: 413.8, markValuation: 14000000000 },
  { symbol: "T-SpaceX", mint: "TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v", markPrice: 423, markValuation: 800000000000 },
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const byCompany = <T extends { company: string }>(rows: T[], c: string) => rows.find((r) => r.company === c)!;

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

test("cross-venue compares valuation, never raw price", () => {
  const c = byCompany(crossVenue(PS, TE), "SpaceX");
  assert.equal(c.company, "SpaceX");
  assert.equal(c.tesseraValuation, 800000000000);
  assert.equal(c.prestocksValuation, 1975862383144);
  assert.equal(r2(c.spreadPct), 146.98);
  assert.equal("tokenPx" in c, false, "cross-venue row must not carry a tradeable price");
  assert.equal("mint" in c, false, "cross-venue row must not carry a mint");
});

// T6 is enforced structurally, not by convention: if this key set ever grows a
// price or a mint, a later UI task could wire a swap button onto a pair of
// tokens that are not convertible into one another. Freeze the shape.
test("cross-venue row exposes exactly four keys and nothing tradeable", () => {
  for (const c of crossVenue(PS, TE)) {
    assert.deepEqual(Object.keys(c).sort(), ["company", "prestocksValuation", "spreadPct", "tesseraValuation"]);
    for (const banned of ["tokenPx", "tokenPrice", "markPx", "markPrice", "mint", "contract_address", "impliedValuation"]) {
      assert.equal(banned in c, false, `cross-venue row must not carry ${banned}`);
    }
  }
});

test("cross-venue uses markValuation on both sides, not impliedValuation", () => {
  const c = byCompany(crossVenue(PS, TE), "OpenAI");
  assert.equal(c.prestocksValuation, 1199271235274, "must be markValuation");
  assert.notEqual(c.prestocksValuation, 1217573878707, "must not be impliedValuation");
  assert.equal(r2(c.spreadPct), 26.24);
});

test("tessera tokens with no PreStocks counterpart are dropped", () => {
  const rows = crossVenue(PS, TE);
  assert.equal(rows.length, 2, "T-Kalshi has no PreStocks row in this fixture");
  assert.equal(rows.some((r) => r.company === "Kalshi"), false);
});

test("tessera name map strips the T- prefix", () => {
  assert.equal(TESSERA_NAME_MAP["T-SpaceX"], "SpaceX");
  assert.equal(TESSERA_NAME_MAP["T-OpenAI"], "OpenAI");
  assert.equal(TESSERA_NAME_MAP["T-Kalshi"], "Kalshi");
});
