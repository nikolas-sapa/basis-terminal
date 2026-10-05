import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { normalizePreStocks, type PreIpoRow } from "../../../lib/preipo.ts";

// Resolve the same NextResponse and path aliases as Next's bundler, without
// replacing the route or its response implementation.
const ROOT = new URL("../../../", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(ROOT)};
      export async function resolve(spec, ctx, next) {
        if (spec === "next/server") return next("next/server.js", ctx);
        if (spec.startsWith("@/")) {
          const p = ROOT + spec.slice(2);
          return next(p.endsWith(".ts") ? p : p + ".ts", ctx);
        }
        return next(spec, ctx);
      }
    `),
  import.meta.url,
);
const { GET } = await import("./route.ts");

const VALID = [
  { name: "SpaceX PreStocks", symbol: "SPACEX", contract_address: "fixture-spacex", markPrice: 150, tokenPrice: 120 },
  { name: "OpenAI PreStocks", symbol: "OPENAI", contract_address: "fixture-openai", markPrice: 100, tokenPrice: 101 },
];

type Body = { rows: PreIpoRow[]; sources: { prestocks: boolean }; fetchedAt: string };

async function call(body: unknown, status = 200) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let errors = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://prestocks.com/api/prestocks");
    assert.equal(init?.cache, "no-store");
    // A json() fixture retains NaN/Infinity, which JSON.stringify would turn
    // into null. The route must reject both representations.
    return { ok: status === 200, status, json: async () => body } as Response;
  };
  console.error = () => { errors++; };
  try {
    const response = await GET();
    return { status: response.status, body: await response.json() as Body, errors };
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

const invalidRows: [string, unknown][] = [
  ["null", null],
  ["primitive", 7],
  ["missing name", { ...VALID[0], name: undefined }],
  ["numeric name", { ...VALID[0], name: 7 }],
  ["blank name", { ...VALID[0], name: " " }],
  ["missing symbol", { ...VALID[0], symbol: undefined }],
  ["blank symbol", { ...VALID[0], symbol: " " }],
  ["missing mint", { ...VALID[0], contract_address: undefined }],
  ["blank mint", { ...VALID[0], contract_address: " " }],
  ["zero reference", { ...VALID[0], markPrice: 0 }],
  ["negative reference", { ...VALID[0], markPrice: -1 }],
  ["NaN reference", { ...VALID[0], markPrice: NaN }],
  ["infinite reference", { ...VALID[0], markPrice: Infinity }],
  ["NaN token", { ...VALID[0], tokenPrice: NaN }],
  ["infinite token", { ...VALID[0], tokenPrice: Infinity }],
  ["negative token", { ...VALID[0], tokenPrice: -1 }],
  ["premium overflow", { ...VALID[0], markPrice: Number.MIN_VALUE, tokenPrice: Number.MAX_VALUE }],
  ["empty normalized company", { ...VALID[0], name: " PreStocks" }],
];

for (const [name, row] of invalidRows) {
  test(`PreStocks route degrades ${name} to HTTP 200, zero rows, source false`, async () => {
    const result = await call([row]);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.rows, []);
    assert.equal(result.body.sources.prestocks, false);
    assert.equal(result.errors, 1);
  });
}

test("PreStocks route preserves a valid two-row response and empty valid array", async () => {
  const valid = await call(VALID);
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.rows, normalizePreStocks(VALID));
  assert.equal(valid.body.sources.prestocks, true);
  assert.equal(valid.errors, 0);
  assert.ok(Number.isFinite(Date.parse(valid.body.fetchedAt)));
  const empty = await call([]);
  assert.deepEqual(empty.body.rows, []);
  assert.equal(empty.body.sources.prestocks, true);
});

test("PreStocks route rejects a mixed batch atomically, then recovers", async () => {
  const invalid = await call([VALID[0], { ...VALID[1], markPrice: 0 }]);
  assert.equal(invalid.status, 200);
  assert.deepEqual(invalid.body.rows, []);
  assert.equal(invalid.body.sources.prestocks, false);
  assert.equal(invalid.errors, 1);
  const recovered = await call(VALID);
  assert.equal(recovered.body.rows.length, 2);
  assert.equal(recovered.body.sources.prestocks, true);
});

test("PreStocks route preserves zero token as a -100% discount", async () => {
  const result = await call([{ ...VALID[0], tokenPrice: 0 }]);
  assert.equal(result.body.sources.prestocks, true);
  assert.equal(result.body.rows[0].premiumPct, -100);
});

test("PreStocks route reports upstream non-array and HTTP failures", async () => {
  for (const result of [await call(null), await call(VALID, 502)]) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.rows, []);
    assert.equal(result.body.sources.prestocks, false);
    assert.equal(result.errors, 1);
  }
});
