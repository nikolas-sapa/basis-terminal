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
