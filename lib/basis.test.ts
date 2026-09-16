import { test } from "node:test";
import assert from "node:assert/strict";
import { bps, verdict, premium, isStale } from "./basis.ts";

test("bps: token above underlying is positive", () => {
  assert.equal(bps(234.11, 232.80), 56);
});
test("bps: token below underlying is negative", () => {
  assert.equal(bps(412.05, 414.90), -69);
});
test("bps: identical prices are zero", () => {
  assert.equal(bps(100, 100), 0);
});
test("bps: zero underlying does not return Infinity", () => {
  assert.equal(bps(100, 0), 0);
});
test("verdict: thresholds at 25bps", () => {
  assert.equal(verdict(56), "RICH");
  assert.equal(verdict(-69), "CHEAP");
  assert.equal(verdict(10), "FAIR");
});
test("premium: SpaceX real numbers", () => {
  assert.equal(Math.round(premium(112.95018815, 144.23096943) * 100) / 100, -21.69);
});
test("isStale: identical samples are stale", () => {
  assert.equal(isStale([100, 100, 100]), true);
});
test("isStale: any movement is live", () => {
  assert.equal(isStale([100, 100.01, 100]), false);
});
test("isStale: fewer than 3 samples is not yet stale", () => {
  assert.equal(isStale([100, 100]), false);
});
