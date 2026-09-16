"use client";

import { useEffect, useState } from "react";
import styles from "./tier2.module.css";

// Deliberately not a steady poller. Tessera's marks are hand-set and did not
// move across repeated polling, so a ticking clock here would imply a liveness
// this data does not have. The stamp says when the snapshot was taken.
// It does retry while it has nothing: a single transient failure at load (seen
// live, Tessera answered the premium table but not this one) would otherwise
// leave the section reading "outage" for the rest of the session. Retries stop
// the moment there is a row, so the steady state is one request.
// The first request is staggered so it does not land in the same instant as the
// premium table's first poll: both go through /api/preipo, and PreStocks 429s
// two requests fired back to back.
const FIRST_FETCH_DELAY_MS = 1_200;
const RETRY_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60_000;

type CrossRow = {
  company: string;
  tesseraValuation: number;
  prestocksValuation: number;
  spreadPct: number;
};

type Sources = { prestocks: boolean; tessera: boolean };
type Feed = { crossVenue: CrossRow[]; sources: Sources; fetchedAt: string };

const val = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19) + "Z";
};

export function CrossVenue() {
  const [rows, setRows] = useState<CrossRow[]>([]);
  const [sources, setSources] = useState<Sources | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const retry = (attempt: number) => {
      const wait = Math.min(RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
      timers.push(setTimeout(() => load(attempt + 1), wait));
    };

    async function load(attempt: number) {
      try {
        const res = await fetch("/api/preipo", { cache: "no-store" });
        if (!res.ok) throw new Error(`/api/preipo returned ${res.status}`);
        const feed: Feed = await res.json();
        if (cancelled) return;

        setSources(feed.sources);
        setFetchedAt(feed.fetchedAt);
        setError(null);

        // A row needs both venues. Until there is one, say what is missing and
        // keep trying; a rate limit should not be a permanent empty section.
        if (feed.crossVenue.length > 0) {
          setRows(feed.crossVenue);
          setLoading(false);
          return;
        }
        if (attempt > 0) setLoading(false);
        retry(attempt);
      } catch (err) {
        if (cancelled) return;
        if (attempt > 0) {
          setLoading(false);
          setError(err instanceof Error ? err.message : "request failed");
        }
        retry(attempt);
      }
    }

    timers.push(setTimeout(() => load(0), FIRST_FETCH_DELAY_MS));
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  const missing =
    !loading &&
    rows.length === 0 &&
    [
      sources?.prestocks === false ? "PreStocks" : null,
      sources?.tessera === false ? "Tessera" : null,
    ].filter(Boolean);

  return (
    <section className={styles.section} aria-labelledby="crossvenue-heading">
      <header className={styles.head}>
        <div>
          <div className={styles.title}>
            <h2 className={styles.h2} id="crossvenue-heading">
              Cross-venue valuation
            </h2>
            <span className={styles.tier}>TIER 2 &middot; RELATIVE VALUE</span>
          </div>
          <p className={styles.sub}>
            The three companies listed on both Tessera and PreStocks, compared on the company
            valuation each venue&apos;s own mark implies. Raw token prices are not comparable
            across the two venues: each token represents a different fraction of a share.
          </p>
        </div>
        <div className={styles.meta}>
          <span className={styles.stamp}>
            {fetchedAt ? `snapshot ${clock(fetchedAt)}` : "fetching…"}
          </span>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className={`${styles.notice} ${!loading ? styles.noticeDown : ""}`} role="status">
          {loading ? <InfoIcon /> : <WarnIcon />}
          <span>
            {loading
              ? "Loading cross-venue marks…"
              : error
                ? `${error}. No comparison available; this is an outage, not an absence of overlap.`
                : missing && missing.length > 0
                  ? `${missing.join(" and ")} did not answer. A cross-venue row needs both venues, so none are shown. This is an outage, not an absence of overlap.`
                  : "No company is currently listed on both venues."}
          </span>
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Relative value, not arbitrage. These tokens are issued by separate entities into
              separate SPVs, are not convertible into one another, and have no date on which
              their prices must converge.
            </caption>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col" className={styles.num}>
                  Tessera mark valuation
                </th>
                <th scope="col" className={styles.num}>
                  PreStocks mark valuation
                </th>
                <th scope="col" className={styles.num}>
                  Spread
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.company}>
                  <th scope="row" className={styles.company}>
                    {r.company}
                  </th>
                  <td className={styles.num}>{val.format(r.tesseraValuation)}</td>
                  <td className={styles.num}>{val.format(r.prestocksValuation)}</td>
                  {/* Uncoloured on purpose: a red/green spread would read as a
                      trade direction, and there is no position to take here. */}
                  <td className={styles.num}>{pct(r.spreadPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
