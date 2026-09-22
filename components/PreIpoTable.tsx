"use client";

import { useEffect, useState } from "react";
import { isStale } from "@/lib/basis";
import type { PreIpoRow } from "@/lib/preipo";
import styles from "./tier2.module.css";

// Measured, not guessed. Polling PreStocks every 3s returned 429 after five
// requests, and a 20s cadence still hit one, so this has to be slow regardless.
// Over 15 polls at 20s, the tokens that do move held a flat plateau for 60-80s
// at a time. Three samples 45s apart span 90s, which clears that plateau; at 30s
// the window is 60s and a moving token lands three identical samples often
// enough to be labelled STATIC. Slower poll, truer badge.
const POLL_MS = 45_000;
const SAMPLE_WINDOW = 3;

type Sources = { prestocks: boolean; tessera: boolean };
type Feed = { rows: PreIpoRow[]; sources: Sources; fetchedAt: string };

type Liveness = "LIVE" | "STATIC" | "CHECKING";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19) + "Z";
};

function liveness(samples: number[] | undefined): Liveness {
  // Fewer than three samples is not evidence of movement either way. isStale
  // returns false there, so reading its output directly would paint an unproven
  // row as a live tick, which is the one thing this badge exists to prevent.
  if (!samples || samples.length < SAMPLE_WINDOW) return "CHECKING";
  return isStale(samples) ? "STATIC" : "LIVE";
}

function LivenessBadge({ state, count }: { state: Liveness; count: number }) {
  const label =
    state === "LIVE"
      ? `Token price moved across the last ${count} polls`
      : state === "STATIC"
        ? `Token price byte-identical across the last ${count} polls; this row moves only when its mark moves`
        : `${count} of ${SAMPLE_WINDOW} samples collected`;
  return (
    <span
      className={`${styles.badge} ${state === "LIVE" ? styles.badgeLive : ""}`}
      title={label}
    >
      <span
        className={`${styles.dot} ${state === "LIVE" ? styles.pulse : ""}`}
        aria-hidden="true"
      />
      {/* Show the sample count while the window is still filling. A bare
          "CHECKING" for the ~135s the three polls take reads as a stuck
          column; "1/3" reads as a measurement in progress, which is what it
          is. The verdict still waits for the full window. */}
      {state === "CHECKING" ? `CHECKING ${count}/${SAMPLE_WINDOW}` : state}
    </span>
  );
}

export function PreIpoTable() {
  const [rows, setRows] = useState<PreIpoRow[]>([]);
  const [samples, setSamples] = useState<Record<string, number[]>>({});
  const [sources, setSources] = useState<Sources | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/preipo", { cache: "no-store" });
        if (!res.ok) throw new Error(`/api/preipo returned ${res.status}`);
        const feed: Feed = await res.json();
        if (cancelled) return;

        setSources(feed.sources);
        setFetchedAt(feed.fetchedAt);
        setError(null);
        setLoading(false);

        // A failed upstream degrades to an empty array server-side. Replacing
        // good rows with it would blank a working table on one 429, and feeding
        // the gap into the sample window would fake staleness. Keep the last
        // good data, flag the source as down, record nothing.
        if (feed.sources.prestocks && feed.rows.length > 0) {
          setRows(feed.rows);
          setSamples((prev) => {
            const next: Record<string, number[]> = {};
            for (const r of feed.rows) {
              next[r.symbol] = [...(prev[r.symbol] ?? []), r.tokenPx].slice(-SAMPLE_WINDOW);
            }
            return next;
          });
        }
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "request failed");
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const down = error !== null || (sources !== null && !sources.prestocks);

  return (
    <section className={styles.section} aria-labelledby="preipo-heading">
      <header className={styles.head}>
        <div>
          <div className={styles.title}>
            <h2 className={styles.h2} id="preipo-heading">
              Pre-IPO premium
            </h2>
            <span className={styles.tier}>TIER 2 &middot; RELATIVE VALUE</span>
          </div>
          <p className={styles.sub}>
            Each PreStocks token against that venue&apos;s own mark for the same company. A
            premium here is not a tradeable basis: there is no second venue to settle it
            against, so this table carries no action.
          </p>
        </div>
        <div className={styles.meta}>
          <div className={styles.sources}>
            <SourceChip name="PreStocks" up={sources?.prestocks ?? null} />
            <SourceChip name="Tessera" up={sources?.tessera ?? null} />
          </div>
          <span className={styles.stamp}>
            {fetchedAt ? `fetched ${clock(fetchedAt)}` : "fetching…"}
          </span>
        </div>
      </header>

      {down && (
        <p className={`${styles.notice} ${styles.noticeDown}`} role="status">
          <WarnIcon />
          <span>
            {error ?? "PreStocks did not answer the last poll (it rate-limits)."}{" "}
            {rows.length > 0
              ? "Rows below are the last good response, not current."
              : "No rows to show. This is an outage, not an empty venue."}
          </span>
        </p>
      )}

      {rows.length === 0 && !down && (
        <p className={styles.notice} role="status">
          <InfoIcon />
          <span>{loading ? "Loading pre-IPO marks…" : "No pre-IPO rows returned."}</span>
        </p>
      )}

      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Premium is token price over the venue mark. Negative is a discount to mark.
              Liveness compares the last {SAMPLE_WINDOW} polls of each token price,{" "}
              {POLL_MS / 1000}s apart: a STATIC row held one price for that whole window and
              moves only when its mark moves, so it is never drawn as a live tick.
            </caption>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col" className={styles.num}>
                  Mark
                </th>
                <th scope="col" className={styles.num}>
                  Token price
                </th>
                <th scope="col" className={styles.num}>
                  Premium %
                </th>
                <th scope="col">Liveness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const seen = samples[r.symbol] ?? [];
                return (
                  <tr key={r.mint}>
                    <th scope="row" className={styles.company}>
                      {r.company}
                      <span className={styles.symbol}>{r.symbol}</span>
                    </th>
                    <td className={styles.num} data-label="Mark">{usd.format(r.markPx)}</td>
                    <td className={styles.num} data-label="Token price">{usd.format(r.tokenPx)}</td>
                    <td
                      data-label="Premium %"
                      className={`${styles.num} ${r.premiumPct > 0 ? styles.rich : r.premiumPct < 0 ? styles.cheap : ""}`}
                    >
                      {pct(r.premiumPct)}
                    </td>
                    <td data-label="Liveness">
                      <LivenessBadge state={liveness(seen)} count={seen.length} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SourceChip({ name, up }: { name: string; up: boolean | null }) {
  const state = up === null ? "unknown" : up ? "live" : "down";
  return (
    <span className={`${styles.source} ${up === false ? styles.sourceDown : ""}`}>
      <span
        className={`${styles.dot} ${up === true ? styles.dotUp : up === false ? styles.dotDown : ""}`}
        aria-hidden="true"
      />
      {name} {state}
    </span>
  );
}

function WarnIcon() {
  return (
    <svg
      className={styles.icon}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      className={styles.icon}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}
