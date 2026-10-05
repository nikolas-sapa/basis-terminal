import { NextResponse } from "next/server";
import { normalizePreStocks } from "@/lib/preipo";
import type { PreIpoRow } from "@/lib/preipo";

const PRESTOCKS = "https://prestocks.com/api/prestocks";

export const revalidate = 0;

// ponytail: an upstream failure degrades to an empty list rather than a 500, but
// it is logged loudly and reported in `sources` so an empty table is never
// mistaken for "these venues list nothing today".
async function fetchRows(url: string): Promise<{ data: PreIpoRow[]; ok: boolean }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.error(`[preipo] ${url} returned ${res.status}`);
      return { data: [], ok: false };
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      console.error(`[preipo] ${url} returned ${typeof body}, expected an array`);
      return { data: [], ok: false };
    }
    return { data: normalizePreStocks(body), ok: true };
  } catch (err) {
    console.error(`[preipo] ${url} failed:`, err);
    return { data: [], ok: false };
  }
}

export async function GET() {
  const ps = await fetchRows(PRESTOCKS);

  return NextResponse.json({
    rows: ps.data.sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct)),
    sources: { prestocks: ps.ok },
    fetchedAt: new Date().toISOString(),
  });
}
