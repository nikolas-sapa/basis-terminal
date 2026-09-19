"use client";

import { useEffect, useState } from "react";
import { LIQUIDITY_FLOOR_USD } from "@/lib/mints";
import { UNDER_FRESH_SEC, type BasisPair, type Unresolved } from "@/lib/quotes";
import { Badge, VerdictBadge } from "./Badge";
import { SwapPanel, type SwapTarget } from "./SwapPanel";
import styles from "./tier1.module.css";

// Matches the Tier 2 cadence on this page, and is set by upstream budgets
// rather than by taste. Yahoo is an IP-level bucket that answered 3 of 15
// concurrent requests and locked the IP out for minutes; Finnhub's free tier is
// 60 requests/minute; PreStocks, which the Tier 2 tables poll from the same
// browser, 429s well inside 20s. The route memoises both legs, but a serverless
// deploy runs several instances and a cold one starts with an empty memo, so
// client cadence does reach the upstreams. 10s here would be a self-inflicted
// outage. The cadence and the cache window are both stated on screen.
const POLL_MS = 45_000;

/**
 * The session answer, narrowed to the three fields rendered here. Structural on
 * purpose: the underlying-price provider is being swapped out as this is
 * written, so this must not break on a renamed export.
 */
type MarketStatus = {
  isOpen?: boolean;
  session?: string | null;
  holiday?: string | null;
};

type Feed = {
  pairs?: BasisPair[];
  /** Keyed by provider name, which changes when a leg is swapped. */
  sources?: Record<string, boolean>;
  unresolved?: Unresolved[];
  /** Non-fatal problems behind a 200. */
  degraded?: string[];
  marketStatus?: MarketStatus | null;
  fetchedAt?: string;
  error?: string;
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const signedBps = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19) + "Z";
};

export function BasisTable() {
  const [rows, setRows] = useState<BasisPair[]>([]);
  const [sources, setSources] = useState<Record<string, boolean> | null>(null);
  const [unresolved, setUnresolved] = useState<Unresolved[]>([]);
  const [degraded, setDegraded] = useState<string[]>([]);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  /** When rows last arrived. At a 45s cadence an outage needs a duration. */
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [swap, setSwap] = useState<SwapTarget | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/basis", { cache: "no-store" });
        // The route answers JSON on its failure paths too, and that body names
        // the upstream and the reason. Read it before deciding anything.
        const feed: Feed | null = await res.json().catch(() => null);
        if (cancelled) return;

        setLoading(false);
        setSources(feed?.sources ?? null);
        setUnresolved(feed?.unresolved ?? []);
        setDegraded(feed?.degraded ?? []);
        setMarketStatus(feed?.marketStatus ?? null);
        setFetchedAt(feed?.fetchedAt ?? null);

        if (!res.ok) {
          // ponytail: rows are dropped, not held. A stale price under a live
          // clock is the one lie this table must never tell, and an empty table
          // with no banner is the other. So: no rows, and a loud reason.
          setRows([]);
          setError(
            feed?.error
              ? `/api/basis returned ${res.status}. ${feed.error}`
              : `/api/basis returned ${res.status} and no diagnosis in the body.`,
          );
          return;
        }

        setError(null);
        setRows(feed?.pairs ?? []);
        if ((feed?.pairs ?? []).length > 0) setLastGoodAt(feed?.fetchedAt ?? null);
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        setRows([]);
        setError(
          `Could not reach /api/basis: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /**
   * `sources.X` means "X served a row this round", which is not the same as
   * "X is healthy". Yahoo is a fallback: while Finnhub is up, Yahoo is
   * deliberately never called, and rendering that as "yahoo down" tells a
   * visitor the product is broken when it is working exactly as designed.
   * A fallback that is idle is on standby; only a fallback that was actually
   * needed and failed is down.
   */
  const finnhubUp = sources?.finnhub === true;
  const chipState = (name: string, served: boolean): "live" | "down" | "standby" => {
    if (served) return "live";
    if (name === "yahoo" && finnhubUp) return "standby";
    return "down";
  };
  const sourceChips = Object.entries(sources ?? {}).map(
    ([name, served]) => [name, chipState(name, served === true)] as const,
  );
  const holiday = marketStatus?.holiday ?? null;
  const session = marketStatus?.session ?? null;

  return (
    <section className={styles.section} aria-labelledby="basis-heading">
      <header className={styles.head}>
        <div>
          <div className={styles.title}>
            <h2 className={styles.h2} id="basis-heading">
              Tokenized equity basis
            </h2>
            <span className={styles.tier}>TIER 1 &middot; TRADEABLE BASIS</span>
          </div>
          <p className={styles.sub}>
            Each xStock against the listed share it tracks, widest gap first. Both legs are
            fetched server-side and every row names the upstream that produced each number.
            Polled every {POLL_MS / 1000}s; an underlying quote older than {UNDER_FRESH_SEC}s
            is labelled <code>:cached</code> on its own row rather than passed off as a live
            tick.
          </p>
        </div>
        <div className={styles.meta}>
          {sourceChips.length > 0 && (
            <div className={styles.sources}>
              {sourceChips.map(([name, state]) => (
                <span
                  key={name}
                  className={`${styles.source} ${state === "down" ? styles.sourceDown : ""}`}
                  title={
                    state === "live"
                      ? `${name} answered the last poll`
                      : state === "standby"
                        ? `${name} is the fallback and was not needed: Finnhub answered every symbol`
                        : `${name} did not answer the last poll`
                  }
                >
                  <span
                    className={`${styles.dot} ${state === "live" ? styles.dotUp : state === "standby" ? styles.dotIdle : styles.dotDown}`}
                    aria-hidden="true"
                  />
                  {name} {state}
                </span>
              ))}
            </div>
          )}
          <span className={styles.stamp}>
            {fetchedAt ? `fetched ${clock(fetchedAt)}` : "fetching…"}
          </span>
        </div>
      </header>

      {error && (
        <p className={`${styles.notice} ${styles.noticeDown}`} role="alert">
          <WarnIcon />
          <span className={styles.noticeBody}>
            <span>
              No basis rows are being shown because a price leg is down, not because the gap
              closed. Nothing below is a quote.
            </span>
            <span className={styles.errorDetail}>{error}</span>
            {lastGoodAt && (
              <span>
                Last complete response was {clock(lastGoodAt)}. Those rows are withheld rather
                than redrawn under a live clock; the next attempt is within {POLL_MS / 1000}s.
              </span>
            )}
          </span>
        </p>
      )}

      {!error && degraded.length > 0 && (
        <p className={`${styles.notice} ${styles.noticeDown}`} role="status">
          <WarnIcon />
          <span className={styles.noticeBody}>
            <span>Rows are rendering, but a leg is degraded:</span>
            {degraded.map((d) => (
              <span key={d} className={styles.errorDetail}>
                {d}
              </span>
            ))}
          </span>
        </p>
      )}

      {loading && (
        <p className={styles.notice} role="status">
          <InfoIcon />
          <span>Loading the basis table…</span>
        </p>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className={`${styles.notice} ${styles.noticeDown}`} role="alert">
          <WarnIcon />
          <span>
            The route answered without an error and without a single row. Treat that as a
            fault, not as an absence of basis.
          </span>
        </p>
      )}

      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>
              Basis is the token price against the underlying, in basis points: positive is
              RICH (the token costs more than the share), negative is CHEAP, and anything
              inside 25 bps is FAIR. Liquidity is the DEX depth behind the token leg; below{" "}
              {usdWhole.format(LIQUIDITY_FLOOR_USD)} no action is offered, because slippage on
              a thin pool eats a basis this size several times over. The label under each
              price is the upstream that produced it: a <code>:cached</code> suffix means that
              leg was last read more than {UNDER_FRESH_SEC}s ago and is a memoised quote, not
              this round&apos;s read, so the basis beside it is that stale too.{" "}
              <strong>The basis is two different things added together.</strong> An xStock is
              a wrapper: the issuer publishes its own NAV for the token, and the pool trades
              around that NAV. <em>vs NAV</em> is how far the pool has drifted from it, and is
              the only part a swap on this page can capture. <em>NAV vs share</em> is how well
              the issuer tracks the real stock, which sits near zero in practice and which no
              trade here can act on. A wide combined basis made mostly of tracking error is
              not an opportunity, so the halves are shown separately rather than summed.
            </caption>
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col" className={styles.num}>
                  Token price
                </th>
                <th scope="col" className={styles.num}>
                  Underlying price
                </th>
                <th scope="col" className={styles.num}>
                  Basis (bps)
                </th>
                <th scope="col" className={styles.num} title="The half of the basis a swap can capture: how far the DEX pool sits from the issuer's own NAV">
                  vs NAV
                </th>
                <th scope="col" className={styles.num} title="The half a swap cannot capture: how well the issuer tracks the real share">
                  NAV vs share
                </th>
                <th scope="col">Verdict</th>
                <th scope="col" className={styles.num}>
                  Liquidity
                </th>
                <th scope="col">Market state</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const cheap = p.bps < 0;
                const open = swap?.mint === p.mint;
                return (
                  <tr key={p.mint}>
                    <th scope="row" className={styles.symbolCell}>
                      {p.sym}
                      <span className={styles.symbol}>{p.tokenSym}</span>
                    </th>
                    <td className={styles.num}>
                      {usd.format(p.tokenPx)}
                      <span className={styles.leg} title="Upstream that priced the token leg">
                        {p.source.token}
                      </span>
                    </td>
                    <td className={styles.num}>
                      {usd.format(p.underPx)}
                      <span
                        className={styles.leg}
                        title={
                          p.source.under.endsWith(":cached")
                            ? `Memoised: last read more than ${UNDER_FRESH_SEC}s ago, not fetched this round`
                            : `Upstream that priced the underlying leg, read within the last ${UNDER_FRESH_SEC}s`
                        }
                      >
                        {p.source.under}
                      </span>
                    </td>
                    <td
                      className={`${styles.num} ${p.bps > 0 ? styles.rich : p.bps < 0 ? styles.cheap : ""}`}
                    >
                      {signedBps(p.bps)}
                    </td>
                    {/* The tradeable half. Bold because it is the only number
                        on this row a swap can act on. */}
                    <td
                      className={`${styles.num} ${styles.tradeableHalf}`}
                      title={
                        p.issuerPx === null
                          ? "The issuer published no NAV for this token, so the basis cannot be split"
                          : `Pool is ${signedBps(p.dexVsIssuerBps ?? 0)} bps from the issuer NAV of ${usd.format(p.issuerPx)}`
                      }
                    >
                      {p.dexVsIssuerBps === null ? "—" : signedBps(p.dexVsIssuerBps)}
                    </td>
                    <td
                      className={styles.num}
                      title={
                        p.issuerPx === null
                          ? "No issuer NAV published"
                          : "Issuer tracking error against the real share. Near zero means the wrapper is doing its job; a swap cannot capture this."
                      }
                    >
                      {p.issuerVsEquityBps === null ? "—" : signedBps(p.issuerVsEquityBps)}
                    </td>
                    <td>
                      <VerdictBadge verdict={p.verdict} bps={p.bps} />
                    </td>
                    <td
                      className={styles.num}
                      title={`${usdWhole.format(p.liquidityUsd)} of reported DEX depth behind ${p.tokenSym}`}
                    >
                      {usdCompact.format(p.liquidityUsd)}
                    </td>
                    <td>
                      <span className={styles.state}>
                        {p.marketOpen ? (
                          <Badge tone="accent" dot title="Regular US session, live prints">
                            OPEN
                          </Badge>
                        ) : (
                          <>
                            <Badge tone="neutral" title="Outside the regular US session">
                              CLOSED
                            </Badge>
                            {/* Never hidden: a basis measured against an
                                overnight last close is not a live basis. */}
                            <span className={styles.stateNote}>
                              NYSE closed, underlying is last close
                              {holiday ? ` (${holiday})` : ""}
                              {!holiday && session && session !== "regular"
                                ? ` (${session} session)`
                                : ""}
                            </span>
                          </>
                        )}
                      </span>
                    </td>
                    <td className={styles.action}>
                      {p.tradeable ? (
                        <button
                          type="button"
                          className={`${styles.swapBtn} ${open ? styles.swapBtnOpen : ""}`}
                          aria-expanded={open}
                          aria-label={
                            cheap
                              ? `Buy ${p.tokenSym} with USDC`
                              : `Sell ${p.tokenSym} for USDC`
                          }
                          onClick={() =>
                            setSwap(
                              open
                                ? null
                                : {
                                    sym: p.sym,
                                    tokenSym: p.tokenSym,
                                    mint: p.mint,
                                    cheap,
                                  },
                            )
                          }
                        >
                          {cheap ? "Buy" : "Sell"} {p.tokenSym}
                        </button>
                      ) : (
                        /* An absent control is explained. NFLXx sits at ~$3.3k
                           of depth against the floor, which is why it has no
                           button; missing and broken must not look alike. */
                        <span
                          className={styles.noAction}
                          title={`Reported depth ${usdWhole.format(p.liquidityUsd)} against a ${usdWhole.format(LIQUIDITY_FLOOR_USD)} floor. A swap here would lose more to slippage than the basis is worth.`}
                        >
                          No action: {usdCompact.format(p.liquidityUsd)} depth is below the{" "}
                          {usdCompact.format(LIQUIDITY_FLOOR_USD)} liquidity floor
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Keyed by mint: picking a different row remounts the panel, so its
          load state starts clean instead of being reset inside an effect. */}
      {swap && <SwapPanel key={swap.mint} target={swap} onClose={() => setSwap(null)} />}

      {unresolved.length > 0 && (
        <div className={`${styles.notice} ${rows.length === 0 ? styles.noticeDown : ""}`}>
          <InfoIcon />
          <span className={styles.noticeBody}>
            <span>
              {unresolved.length} symbol{unresolved.length === 1 ? "" : "s"} on the committed
              list produced no row. Listed rather than dropped, so a missing row is visible:
            </span>
            <ul className={styles.missingList}>
              {unresolved.map((u) => (
                <li key={u.sym} className={styles.missing} title={u.reason}>
                  <span className={styles.missingSym}>{u.sym}</span>
                  {u.reason}
                </li>
              ))}
            </ul>
          </span>
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
