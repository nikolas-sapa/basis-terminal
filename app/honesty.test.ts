import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * T6, the honesty guard.
 *
 * Pre-IPO tokens are not convertible across venues, represent different
 * fractions of a share, and have no date on which their prices must converge.
 * There is therefore no arbitrage on a Tier 2 surface, and a trade button there
 * would mislead a real person with real money. This asserts the absence, at the
 * source level, because a convention that is only written down gets refactored
 * away by the next person in a hurry.
 *
 * Second guard, from the mint-resolution amendment: a mint must never be
 * resolved by symbol search. Searching Jupiter for the uppercase xStock tickers
 * returns a pump.fun impostor for every single one (AAPLX -> "Apple" at
 * 2PdabVsS...pump, $2.4k depth, unverified), so a UI that looked one up by
 * ticker would hand a user's funds to a scam token while displaying Apple's
 * real price next to it.
 *
 * Paths resolve from this file, not from cwd, so `node --test` finds the same
 * files whatever directory it is invoked in.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// CrossVenue was removed with the Tessera integration; PreIpoTable is now the
// only Tier 2 surface, and the rule it must satisfy is unchanged.
const TIER2 = ["components/PreIpoTable.tsx"];
const BANNED = ["SwapPanel", "Jupiter", "onSwap", "initialOutputMint"];

const COMPONENTS = readdirSync(join(ROOT, "components"))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => `components/${f}`);

for (const f of TIER2) {
  test(`${f} renders no swap control`, () => {
    const src = read(f);
    for (const banned of BANNED) {
      assert.ok(!src.includes(banned), `${f} must not reference ${banned}`);
    }
  });
}

// Positive control for the scan above. If SwapPanel were ever renamed, the two
// tests would keep passing while guarding a name nothing uses any more.
test("the Tier 1 table is the surface that does mount a swap", () => {
  const src = read("components/BasisTable.tsx");
  assert.ok(
    src.includes("SwapPanel"),
    "BasisTable must mount SwapPanel, otherwise the Tier 2 scan guards a dead name",
  );
});

/**
 * A pasted base58 address is how the wrong mint gets into a UI. Every mint
 * reaches a component either from `lib/mints.ts` or from the route payload,
 * never as a literal in JSX. Length 40+ only matches real Solana addresses:
 * base58 excludes 0, O, I and l, so ordinary identifiers cannot reach it.
 */
const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{40,}/;

test("no component carries a hardcoded mint address", () => {
  for (const f of COMPONENTS) {
    const hit = BASE58_ADDRESS.exec(read(f));
    assert.equal(hit, null, `${f} contains what looks like a mint literal: ${hit?.[0]}`);
  }
});

/**
 * Every upstream fetch is server-side, so no component has any business
 * touching Jupiter's token list or search endpoints. That is also the exact
 * mechanism the amendment bans: resolving a mint by ticker.
 */
const TOKEN_LOOKUP = ["lite-api.jup.ag", "tokens/v2", "tokens/v1", "?query=", "searchToken"];

test("no component resolves a mint by symbol lookup", () => {
  for (const f of COMPONENTS) {
    const src = read(f);
    for (const banned of TOKEN_LOOKUP) {
      assert.ok(!src.includes(banned), `${f} must not reference a token lookup (${banned})`);
    }
  }
});

test("SwapPanel takes both mints from the committed list", () => {
  const src = read("components/SwapPanel.tsx");
  assert.match(src, /from "@\/lib\/mints"/, "SwapPanel must import from lib/mints");
  assert.ok(src.includes("mintFor("), "SwapPanel must resolve its mint through mintFor()");
  assert.ok(src.includes("USDC_MINT"), "SwapPanel must take USDC from the committed constant");
  assert.ok(
    src.includes("committed.mint !== target.mint"),
    "SwapPanel must cross-check the route's mint against the committed one before mounting",
  );
});
