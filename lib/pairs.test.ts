import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAIRS,
  pythSymbol,
  buildPairs,
  normId,
  STALE_SECONDS,
  type ParsedPriceUpdate,
  type Wanted,
} from "./pairs.ts";

const BANNED = ["TON", "CFX", "GMX", "LION", "IOTX", "MUX", "SPCXX"];

test("allowlist has at least 15 pairs", () => {
  assert.ok(PAIRS.length >= 15, `only ${PAIRS.length}`);
});
test("no known false-positive symbols leaked in", () => {
  for (const p of PAIRS) assert.ok(!BANNED.includes(p.tokenSym), `banned: ${p.tokenSym}`);
});
test("symbols build correctly", () => {
  const s = pythSymbol(PAIRS[0]);
  assert.equal(s.under, "Equity.US.AAPL/USD");
  assert.equal(s.token, "Crypto.AAPLX/USD");
});
test("every pair is unique", () => {
  assert.equal(new Set(PAIRS.map((p) => p.sym)).size, PAIRS.length);
  assert.equal(new Set(PAIRS.map((p) => p.tokenSym)).size, PAIRS.length);
});

// ---- price assembly -------------------------------------------------------
// Fixture mirrors the real Hermes `parsed[]` entry: `price`/`conf` are strings,
// `expo`/`publish_time` are numbers, `id` is bare lowercase hex.
// Public Pyth feed IDs, not credentials: both are published by the open
// /v2/price_feeds metadata endpoint and Pyth echoes them in its own public 403
// error bodies. 64-char lowercase hex trips entropy-based secret scanning.
const UNDER = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688"; // gitleaks:allow
const TOKEN = "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675"; // gitleaks:allow
const NOW = 1_800_000_000;

const upd = (id: string, price: string, publish_time = NOW - 10): ParsedPriceUpdate => ({
  id,
  price: { price, conf: "1000000", expo: -8, publish_time },
});

const wanted: Wanted[] = [{ p: PAIRS[0], underId: UNDER, tokenId: TOKEN }];

test("normId strips an 0x prefix and lowercases", () => {
  assert.equal(normId("0x" + UNDER.toUpperCase()), UNDER);
  assert.equal(normId(UNDER), UNDER);
});

test("string price and negative expo reconstruct the real price", () => {
  const [r] = buildPairs(wanted, [upd(UNDER, "33237500000"), upd(TOKEN, "33409200000")], NOW);
  assert.equal(r.underPx, 332.375);
  assert.equal(r.tokenPx, 334.092);
});

test("bps and verdict are attached", () => {
  const [r] = buildPairs(wanted, [upd(UNDER, "33237500000"), upd(TOKEN, "33409200000")], NOW);
  assert.equal(r.bps, 52);
  assert.equal(r.verdict, "RICH");
  assert.notEqual(r.bps, 0);
});

// The bug this guards: ids prefixed on one side only silently empty the map.
test("a 0x prefix on either side still resolves", () => {
  for (const [u, t] of [["0x" + UNDER, TOKEN], [UNDER, "0x" + TOKEN], ["0x" + UNDER, "0x" + TOKEN]]) {
    const rows = buildPairs([{ p: PAIRS[0], underId: u, tokenId: t }],
      [upd(UNDER, "33237500000"), upd(TOKEN, "33409200000")], NOW);
    assert.equal(rows.length, 1, `lost the row for ${u} / ${t}`);
  }
});

test("a pair missing either leg is dropped, not zeroed", () => {
  assert.equal(buildPairs(wanted, [upd(UNDER, "33237500000")], NOW).length, 0);
  assert.equal(buildPairs(wanted, [], NOW).length, 0);
});

test("marketOpen follows the underlying publish_time", () => {
  const fresh = buildPairs(wanted, [upd(UNDER, "33237500000"), upd(TOKEN, "33409200000")], NOW);
  assert.equal(fresh[0].marketOpen, true);
  const closed = buildPairs(wanted,
    [upd(UNDER, "33237500000", NOW - STALE_SECONDS - 1), upd(TOKEN, "33409200000")], NOW);
  assert.equal(closed[0].marketOpen, false);
  assert.equal(typeof closed[0].marketOpen, "boolean");
});

test("rows come back sorted by absolute basis, widest first", () => {
  const B_UNDER = "a".repeat(64), B_TOKEN = "b".repeat(64);
  const rows = buildPairs(
    [wanted[0], { p: PAIRS[1], underId: B_UNDER, tokenId: B_TOKEN }],
    [
      upd(UNDER, "33237500000"), upd(TOKEN, "33409200000"),      // +52 bps
      upd(B_UNDER, "10000000000"), upd(B_TOKEN, "12000000000"),  // +2000 bps
    ],
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.sym), ["TSLA", "AAPL"]);
});
