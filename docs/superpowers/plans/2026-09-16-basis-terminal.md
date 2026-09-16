# Basis Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-page Solana terminal showing the live price gap between tokenized stocks and what they actually track, with a pre-filled swap on the tradeable ones.

**Architecture:** Next.js App Router on Vercel. Three upstream APIs fetched server-side in route handlers (no CORS, no client keys). All price math lives in one pure, IO-free module that is the only thing unit-tested. Jupiter Plugin mounted client-side handles all wallet and transaction concerns, so this repo contains zero wallet code.

**Tech Stack:** Next.js (App Router), TypeScript, `@jup-ag/plugin`, `node --test` (stdlib, no test framework dependency), Vercel.

**Spec:** `docs/superpowers/specs/2026-09-16-basis-terminal-design.md`

## Global Constraints

- Deadline: Fri 18 Sep 2026, 4:00pm ET. Ship over polish.
- Design DNA: Geist Sans, accent `#006bff`, no orange anywhere, no emoji (icons only).
- Tier 1 (listed equities) may render swap controls. Tier 2 (pre-IPO) MUST NOT, enforced by test T6.
- Pyth pairs come from a hardcoded allowlist. Never regex-match Pyth symbols: that produced `Crypto.TON` (Toncoin) as tokenized AT&T.
- All upstream fetches are server-side only.
- Node 25 runs `.ts` directly. No ts-node, no vitest, no jest.
- Never display a static `tokenPrice` as a live tick. Liveness is per-token.
- No package may be added without `npm show <pkg> version` first. npm only.
- **Task 0 must complete before Task 7:** the repo has no `origin` remote. The hackathon submission requires a GitHub link.

---

### Task 0: Remote

**Files:** none.

- [ ] **Step 1: Create the GitHub repo and wire the remote**

```bash
cd ~/Developer/basis-terminal
gh repo create basis-terminal --public --source=. --remote=origin
```

Expected: `git remote -v` lists `origin`. Without this, Task 7 strands every commit locally.

---

### Task 1: Scaffold and pure basis math

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/globals.css`
- Create: `lib/basis.ts`
- Test: `lib/basis.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `bps(tokenPx: number, underPx: number): number`, `verdict(b: number): "RICH"|"CHEAP"|"FAIR"`, `premium(tokenPx: number, markPx: number): number`, `isStale(samples: number[]): boolean`. Every later task imports from here.

- [ ] **Step 1: Scaffold the app**

```bash
cd ~/Developer/basis-terminal
npx create-next-app@latest . --ts --app --no-src-dir --no-tailwind --eslint --use-npm
```

- [ ] **Step 2: Write the failing test**

```ts
// lib/basis.test.ts
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
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test lib/basis.test.ts`
Expected: FAIL, cannot find module `./basis.ts`.

- [ ] **Step 4: Implement**

```ts
// lib/basis.ts
export function bps(tokenPx: number, underPx: number): number {
  if (!underPx || !Number.isFinite(underPx) || !Number.isFinite(tokenPx)) return 0;
  return Math.round(((tokenPx - underPx) / underPx) * 10_000);
}

export function verdict(b: number): "RICH" | "CHEAP" | "FAIR" {
  if (b > 25) return "RICH";
  if (b < -25) return "CHEAP";
  return "FAIR";
}

export function premium(tokenPx: number, markPx: number): number {
  if (!markPx || !Number.isFinite(markPx) || !Number.isFinite(tokenPx)) return 0;
  return (tokenPx / markPx - 1) * 100;
}

// ponytail: 3 identical samples = stale. Upgrade to a timestamp check if an
// upstream ever exposes one; none of the three currently do.
export function isStale(samples: number[]): boolean {
  if (samples.length < 3) return false;
  return samples.every((s) => s === samples[0]);
}
```

- [ ] **Step 5: Run and confirm green**

Run: `node --test lib/basis.test.ts`
Expected: PASS, 9/9.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold + pure basis math with tests"
```

---

### Task 2: Pyth route handler

**Files:**
- Create: `lib/pairs.ts` (allowlist + mints)
- Create: `app/api/pyth/route.ts`
- Test: `lib/pairs.test.ts`

**Interfaces:**
- Consumes: `bps`, `verdict` from `lib/basis.ts`.
- Produces: `GET /api/pyth` returning `{ pairs: Pair[], fetchedAt: string }` where `Pair = { sym: string, tokenSym: string, tokenPx: number, underPx: number, bps: number, verdict: string, marketOpen: boolean, mint: string | null }`.

- [ ] **Step 1: Write the allowlist**

Mints come from the `mints` research agent. Any symbol whose mint came back UNVERIFIED keeps `mint: null` and renders read-only. Never guess a mint: a wrong address sends funds to the wrong token.

```ts
// lib/pairs.ts
export type PairDef = { sym: string; tokenSym: string; mint: string | null };

// ponytail: hardcoded, not regex-matched. Regexing Pyth symbols yielded
// Crypto.TON (Toncoin) as tokenized AT&T and Crypto.CFX (Conflux) as CF.
export const PAIRS: PairDef[] = [
  { sym: "AAPL",  tokenSym: "AAPLX",  mint: null },
  { sym: "TSLA",  tokenSym: "TSLAX",  mint: null },
  { sym: "NVDA",  tokenSym: "NVDAX",  mint: null },
  { sym: "MSFT",  tokenSym: "MSFTX",  mint: null },
  { sym: "GOOGL", tokenSym: "GOOGLX", mint: null },
  { sym: "AMZN",  tokenSym: "AMZNX",  mint: null },
  { sym: "META",  tokenSym: "METAX",  mint: null },
  { sym: "COIN",  tokenSym: "COINX",  mint: null },
  { sym: "HOOD",  tokenSym: "HOODX",  mint: null },
  { sym: "MSTR",  tokenSym: "MSTRX",  mint: null },
  { sym: "CRCL",  tokenSym: "CRCLX",  mint: null },
  { sym: "SPY",   tokenSym: "SPYX",   mint: null },
  { sym: "QQQ",   tokenSym: "QQQX",   mint: null },
  { sym: "GLD",   tokenSym: "GLDX",   mint: null },
  { sym: "NFLX",  tokenSym: "NFLXX",  mint: null },
];

export const pythSymbol = (p: PairDef) => ({
  under: `Equity.US.${p.sym}/USD`,
  token: `Crypto.${p.tokenSym}/USD`,
});
```

- [ ] **Step 2: Write the failing guard test**

```ts
// lib/pairs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS, pythSymbol } from "./pairs.ts";

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
```

- [ ] **Step 3: Run, confirm fail, then green**

Run: `node --test lib/pairs.test.ts`

- [ ] **Step 4: Implement the route**

```ts
// app/api/pyth/route.ts
import { NextResponse } from "next/server";
import { PAIRS, pythSymbol } from "@/lib/pairs";
import { bps, verdict } from "@/lib/basis";

const HERMES = "https://hermes.pyth.network";
const STALE_SECONDS = 900; // equity feed older than 15m => market closed

export const revalidate = 0;

export async function GET() {
  const feeds = await fetch(`${HERMES}/v2/price_feeds`, { cache: "no-store" }).then((r) => r.json());
  const bySymbol = new Map<string, string>();
  for (const f of feeds) bySymbol.set(f.attributes.symbol, f.id);

  const wanted: { p: (typeof PAIRS)[number]; underId: string; tokenId: string }[] = [];
  for (const p of PAIRS) {
    const s = pythSymbol(p);
    const underId = bySymbol.get(s.under);
    const tokenId = bySymbol.get(s.token);
    if (underId && tokenId) wanted.push({ p, underId, tokenId });
  }

  const ids = wanted.flatMap((w) => [w.underId, w.tokenId]);
  const qs = ids.map((i) => `ids[]=${i}`).join("&");
  const latest = await fetch(`${HERMES}/v2/updates/price/latest?${qs}`, { cache: "no-store" }).then((r) => r.json());

  const px = new Map<string, { v: number; t: number }>();
  for (const e of latest.parsed ?? []) {
    px.set(e.id, { v: Number(e.price.price) * 10 ** e.price.expo, t: e.price.publish_time });
  }

  const now = Math.floor(Date.now() / 1000);
  const pairs = wanted
    .flatMap((w) => {
      const u = px.get(w.underId.replace(/^0x/, ""));
      const t = px.get(w.tokenId.replace(/^0x/, ""));
      if (!u || !t) return [];
      const b = bps(t.v, u.v);
      return [{
        sym: w.p.sym, tokenSym: w.p.tokenSym, mint: w.p.mint,
        tokenPx: t.v, underPx: u.v, bps: b, verdict: verdict(b),
        marketOpen: now - u.t < STALE_SECONDS,
      }];
    })
    .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps));

  return NextResponse.json({ pairs, fetchedAt: new Date().toISOString() });
}
```

- [ ] **Step 5: Verify live**

Run: `npm run dev` then `curl -s localhost:3000/api/pyth | jq '.pairs | length, .pairs[0]'`
Expected: >= 15 pairs, first row has non-zero `bps` and a boolean `marketOpen`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Pyth route with hardcoded pair allowlist"
```

---

### Task 3: Pre-IPO route handler

**Files:**
- Create: `app/api/preipo/route.ts`
- Create: `lib/preipo.ts`
- Test: `lib/preipo.test.ts`

**Interfaces:**
- Consumes: `premium` from `lib/basis.ts`.
- Produces: `GET /api/preipo` returning `{ rows: PreIpoRow[], crossVenue: CrossRow[] }` where `PreIpoRow = { company: string, symbol: string, markPx: number, tokenPx: number, premiumPct: number, mint: string, venue: "prestocks" }` and `CrossRow = { company: string, tesseraValuation: number, prestocksValuation: number, spreadPct: number }`.

Runs in parallel with Task 2. No shared files.

- [ ] **Step 1: Write the normalizer test**

```ts
// lib/preipo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePreStocks, crossVenue, TESSERA_NAME_MAP } from "./preipo.ts";

const PS = [{ name: "SpaceX PreStocks", symbol: "SPACEX", contract_address: "Pre1", markPrice: 144.2309694365699, tokenPrice: 112.95018815252176, markValuation: 1497600000000 }];
const TE = [{ symbol: "T-SpaceX", mint: "TSPX", markPrice: 423.0, markValuation: 800000000000 }];

test("premium computed and rounded", () => {
  const [r] = normalizePreStocks(PS as any);
  assert.equal(Math.round(r.premiumPct * 100) / 100, -21.69);
});
test("cross-venue compares valuation, never raw price", () => {
  const [c] = crossVenue(PS as any, TE as any);
  assert.equal(c.company, "SpaceX");
  assert.equal(c.tesseraValuation, 800000000000);
  assert.equal(c.prestocksValuation, 1497600000000);
  assert.ok(c.spreadPct > 80 && c.spreadPct < 95);
  assert.equal("tokenPx" in c, false, "cross-venue row must not carry a tradeable price");
  assert.equal("mint" in c, false, "cross-venue row must not carry a mint");
});
test("tessera name map strips the T- prefix", () => {
  assert.equal(TESSERA_NAME_MAP["T-SpaceX"], "SpaceX");
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `node --test lib/preipo.test.ts`

- [ ] **Step 3: Implement**

```ts
// lib/preipo.ts
import { premium } from "./basis.ts";

export const TESSERA_NAME_MAP: Record<string, string> = {
  "T-OpenAI": "OpenAI", "T-Kalshi": "Kalshi", "T-SpaceX": "SpaceX",
};

export function normalizePreStocks(raw: any[]) {
  return raw.map((r) => ({
    company: r.name.replace(/ PreStocks$/, ""),
    symbol: r.symbol,
    markPx: r.markPrice,
    tokenPx: r.tokenPrice,
    premiumPct: premium(r.tokenPrice, r.markPrice),
    mint: r.contract_address,
    venue: "prestocks" as const,
  }));
}

// ponytail: valuation-only comparison. Raw prices are NOT comparable across
// venues (different share fractions) and the tokens are not convertible, so
// this is relative value, never arbitrage. No price or mint is returned here
// on purpose, so no caller can wire a swap button to it.
export function crossVenue(ps: any[], te: any[]) {
  const psBy = new Map(ps.map((r) => [r.name.replace(/ PreStocks$/, ""), r]));
  return te.flatMap((t) => {
    const company = TESSERA_NAME_MAP[t.symbol];
    const p = company && psBy.get(company);
    if (!p) return [];
    return [{
      company,
      tesseraValuation: t.markValuation,
      prestocksValuation: p.markValuation,
      spreadPct: (p.markValuation / t.markValuation - 1) * 100,
    }];
  });
}
```

```ts
// app/api/preipo/route.ts
import { NextResponse } from "next/server";
import { normalizePreStocks, crossVenue } from "@/lib/preipo";

export const revalidate = 0;

export async function GET() {
  const [ps, te] = await Promise.all([
    fetch("https://prestocks.com/api/prestocks", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
    fetch("https://rest-api.tessera.pe/v1/public/token-details", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
  ]);
  return NextResponse.json({
    rows: normalizePreStocks(ps).sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct)),
    crossVenue: crossVenue(ps, te),
    fetchedAt: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Run tests green, then verify live**

Run: `node --test lib/preipo.test.ts` then `curl -s localhost:3000/api/preipo | jq '.rows | length, .crossVenue'`
Expected: 8 rows, 3 cross-venue rows, SpaceX premium near -21.7%.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pre-IPO route, valuation-only cross-venue"
```

---

### Task 4: Tier 1 basis table UI

**Files:**
- Create: `app/page.tsx`, `components/BasisTable.tsx`, `components/Badge.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `GET /api/pyth`.
- Produces: `<BasisTable pairs={Pair[]} onSwap={(p: Pair) => void} />`. The `onSwap` prop is wired in Task 6.

Runs in parallel with Task 5.

- [ ] **Step 1: Design tokens**

```css
/* app/globals.css */
:root {
  --accent: #006bff;
  --rich: #d92d20;
  --cheap: #027a48;
  --bg: #0a0a0a;
  --fg: #ededed;
  --muted: #8a8a8a;
  --line: #222;
  font-family: Geist, ui-sans-serif, system-ui, sans-serif;
}
/* ponytail: no orange anywhere, per design DNA. rich/cheap are red/green. */
```

- [ ] **Step 2: Build the table**

Columns: Symbol, Token price, Underlying price, Basis (bps), Verdict badge, Market state, Action. Rows arrive pre-sorted by `Math.abs(bps)` descending from the route. Poll `/api/pyth` every 10s from a `"use client"` component. When `marketOpen` is false, render "NYSE closed, underlying is last close" on the row rather than hiding it. A row whose `mint` is `null` renders no action control.

- [ ] **Step 3: Verify**

Run: `npm run dev`, open localhost:3000, confirm >= 15 rows render with non-zero basis values and no orange in the palette.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Tier 1 basis table"
```

---

### Task 5: Tier 2 pre-IPO UI and provenance

**Files:**
- Create: `components/PreIpoTable.tsx`, `components/CrossVenue.tsx`, `components/Provenance.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `GET /api/preipo`.
- Produces: `<PreIpoTable rows={PreIpoRow[]} />`, `<CrossVenue rows={CrossRow[]} />`. Neither accepts an `onSwap` prop. That absence is the point.

Runs in parallel with Task 4.

- [ ] **Step 1: Pre-IPO table**

Columns: Company, Mark, Token price, Premium %, Liveness. No action column. The liveness badge derives from `isStale` over the last 3 polls held in client state. Anduril, Figure AI, Kalshi and Polymarket are expected to show STATIC.

- [ ] **Step 2: Cross-venue section**

Three rows, valuation only. Fixed caption, verbatim:

> Relative value, not arbitrage. These tokens are issued by separate entities into separate SPVs, are not convertible into one another, and have no date on which their prices must converge.

- [ ] **Step 3: Provenance footnotes**

> Tessera marks are hand-set and did not move across repeated polling; Tessera's own proof-of-reserve publishes asset counts, explicitly not dollar valuations, attested approximately monthly.

> PreStocks marks update automatically from a source the operator does not document.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Tier 2 pre-IPO UI with provenance disclosure"
```

---

### Task 6: Jupiter Plugin and the honesty guard

**Files:**
- Create: `components/SwapPanel.tsx`
- Create: `app/honesty.test.ts`
- Modify: `app/page.tsx`, `components/BasisTable.tsx`

**Interfaces:**
- Consumes: `PAIRS[].mint` from Task 2, `onSwap` from Task 4.
- Produces: nothing downstream. Terminal task before deploy.

- [ ] **Step 1: Confirm the package exists**

Run: `npm show @jup-ag/plugin version`
Expected: a real version. If missing or `0.0.0`, stop and fall back to a `jup.ag` deep link.

- [ ] **Step 2: Mount the plugin**

```tsx
// components/SwapPanel.tsx
"use client";
import { useEffect } from "react";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function SwapPanel({ mint, cheap }: { mint: string; cheap: boolean }) {
  useEffect(() => {
    // @ts-expect-error injected by the plugin script
    window.Jupiter?.init({
      displayMode: "integrated",
      integratedTargetId: "jup",
      formProps: {
        swapMode: "ExactIn",
        initialInputMint: cheap ? USDC : mint,
        initialOutputMint: cheap ? mint : USDC,
      },
    });
  }, [mint, cheap]);
  return <div id="jup" />;
}
```

Cheap token: buy it, USDC in. Rich token: sell it, USDC out.

- [ ] **Step 3: Write the honesty guard**

```ts
// app/honesty.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// T6: no swap control may ever reach a Tier 2 surface.
for (const f of ["components/PreIpoTable.tsx", "components/CrossVenue.tsx"]) {
  test(`${f} renders no swap control`, () => {
    const src = readFileSync(f, "utf8");
    for (const banned of ["SwapPanel", "Jupiter", "onSwap", "initialOutputMint"]) {
      assert.ok(!src.includes(banned), `${f} must not reference ${banned}`);
    }
  });
}
```

- [ ] **Step 4: Prove the guard can fail**

Temporarily add `import { SwapPanel } from "./SwapPanel";` to `components/PreIpoTable.tsx`. Run `node --test app/honesty.test.ts` and confirm it goes RED. Remove the import, confirm GREEN. A guard never observed failing is not a guard.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Jupiter Plugin swap on Tier 1 + T6 honesty guard"
```

---

### Task 7: Deploy and verify live

**Files:**
- Create: `README.md`

Requires Task 0 complete.

- [ ] **Step 1: Full test run**

Run: `node --test "lib/**/*.test.ts" "app/**/*.test.ts" && npm run build`
Expected: all green, build succeeds.

- [ ] **Step 2: Deploy**

```bash
vercel --prod
```

- [ ] **Step 3: Verify the live URL, not the build log**

```bash
curl -s https://<deployed>/api/pyth | jq '.pairs | length'
curl -s https://<deployed>/api/preipo | jq '.rows | length'
```

Expected: >= 15 and 8. A green deploy is not a working deploy.

- [ ] **Step 4: README with the honest framing**

State plainly: Tier 1 is a tradeable basis, Tier 2 is relative value and not arbitrage, and neither pre-IPO venue documents its pricing methodology. Name the data sources. Judges read this.

- [ ] **Step 5: Commit and publish to the remote from Task 0**

```bash
git add -A && git commit -m "docs: README"
```

Then publish the branch to `origin` and confirm the commits landed remotely before submitting the GitHub link.

---

## Self-Review

**Spec coverage:** Problem/user -> README (T7). Tier 1 -> Tasks 2, 4, 6. Tier 2 -> Tasks 3, 5. Provenance -> Task 5 Step 3. Liveness badges -> Task 5 Step 1. Allowlist-not-regex -> Task 2 Step 1 plus its guard test. Server-side fetching -> Tasks 2 and 3 route handlers. Design DNA -> Task 4 Step 1. All six spec tests mapped: T1 -> Task 2 Step 5, T2 -> Task 2 `marketOpen`, T3 -> Task 1 tests, T4 -> Task 1 `isStale` plus Task 5, T5 -> Task 6 Step 2, T6 -> Task 6 Step 3. Open risk 1 (mints) -> Task 2 Step 1 null handling. No gaps.

**Placeholder scan:** No TBDs. The one deliberate null is `PAIRS[].mint`, an input awaiting the `mints` agent, not a deferral; its null case has defined behavior (row renders read-only, Task 4 Step 2).

**Type consistency:** `bps`/`verdict`/`premium`/`isStale` signatures are identical across Tasks 1, 2 and 3. The `Pair` shape produced in Task 2 matches what Task 4 consumes. `PreIpoRow`/`CrossRow` produced in Task 3 match Task 5. `CrossRow` deliberately carries neither `mint` nor `tokenPx`, which is what makes T6 structurally enforceable rather than merely a convention.

## Parallelization

```
Task 0 ─┐
Task 1 ─┴─> Task 2 ─┐
           Task 3 ─┴─> Task 4 ─> Task 6 ─> Task 7
                      Task 5 ─┘
```

Tasks 2 and 3 run concurrently (no shared files). Tasks 4 and 5 run concurrently. Per agent governance: implementation agents edit files only and never run git or deploy; the orchestrator holds every commit boundary.
