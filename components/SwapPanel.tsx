"use client";

import { useEffect, useRef, useState } from "react";
import { LIQUIDITY_FLOOR_USD, USDC_MINT, mintFor } from "@/lib/mints";
import styles from "./tier1.module.css";

/**
 * Jupiter Plugin, mounted from the hosted shell at plugin.jup.ag.
 *
 * WHY THE SCRIPT AND NOT THE NPM PACKAGE. `@jup-ag/plugin` exists and is real
 * (1.0.16, checked with `npm show` before a line of this was written), but it
 * cannot be installed here and would not satisfy the mount contract either:
 *
 *   1. It peers `react@^18` / `react-dom@^18` against this repo's React 19, so
 *      npm refuses the tree outright (ERESOLVE), and --legacy-peer-deps only
 *      hides that: its bundle renders through the HOST's React.
 *   2. It also peers `@solana/web3.js` and `@solana/spl-token`, which npm does
 *      not install for you. Using it means adding three dependencies, not one.
 *   3. Its exported `init` assigns `window.Jupiter` as a side effect of the
 *      first call, so `window.Jupiter.init` does not exist on a fresh page at
 *      all. The hosted shell ends with `window.Jupiter = ...` at load time,
 *      which is the API this app is specified against.
 *
 * The shell is the same product and the same `init(formProps)` surface. It
 * bundles its own React 18.3.1 and the Unified Wallet Kit and renders into a
 * shadow root, so it cannot collide with this app's React or leak its Tailwind
 * onto the page. Net dependency cost: zero.
 *
 * Everything to do with wallets, quoting, slippage and signing happens inside
 * that widget. This repo holds no wallet adapter and builds no transaction.
 */

const PLUGIN_SRC = "https://plugin.jup.ag/plugin-v1.js";
const SCRIPT_ID = "jupiter-plugin-v1";
/** Only one instance can exist: `init` unmounts the previous root. */
const TARGET_ID = "jupiter-plugin-target";
const LOAD_TIMEOUT_MS = 20_000;

type JupiterInit = {
  displayMode: "integrated" | "modal" | "widget";
  integratedTargetId?: string;
  formProps?: {
    swapMode?: "ExactIn" | "ExactOut" | "ExactInOrOut";
    initialInputMint?: string;
    initialOutputMint?: string;
  };
};

type JupiterGlobal = {
  init: (props: JupiterInit) => void | Promise<void>;
  close?: () => void;
};

declare global {
  interface Window {
    Jupiter?: JupiterGlobal;
  }
}

let loader: Promise<JupiterGlobal> | null = null;

/** Inject the shell once per document and resolve when `window.Jupiter` lands. */
function loadPlugin(): Promise<JupiterGlobal> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Jupiter Plugin needs a browser"));
  }
  if (window.Jupiter) return Promise.resolve(window.Jupiter);
  if (loader) return loader;

  const pending = new Promise<JupiterGlobal>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const el = existing ?? document.createElement("script");
    // A CDN that hangs rather than erroring would otherwise leave the panel
    // saying "loading" for ever, which reads as our bug and hides theirs.
    const timer = setTimeout(
      () => reject(new Error(`${PLUGIN_SRC} did not load within ${LOAD_TIMEOUT_MS / 1000}s`)),
      LOAD_TIMEOUT_MS,
    );
    el.addEventListener("load", () => {
      clearTimeout(timer);
      if (window.Jupiter) resolve(window.Jupiter);
      else reject(new Error(`${PLUGIN_SRC} loaded but defined no window.Jupiter`));
    });
    el.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${PLUGIN_SRC} could not be fetched`));
    });
    if (!existing) {
      el.id = SCRIPT_ID;
      el.src = PLUGIN_SRC;
      el.async = true;
      document.head.append(el);
    }
  });

  // Let a later open retry after a failed load instead of latching the failure.
  loader = pending.catch((e) => {
    loader = null;
    throw e;
  });
  return loader;
}

export type SwapTarget = {
  sym: string;
  tokenSym: string;
  /** The mint the route sent for this row, cross-checked below, never trusted. */
  mint: string;
  /** Token below its underlying: the basis trade is USDC in, token out. */
  cheap: boolean;
};

const short = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

export function SwapPanel({ target, onClose }: { target: SwapTarget; onClose: () => void }) {
  // ponytail: the mint comes from the committed list keyed on the underlying
  // ticker, never from a symbol search. Searching Jupiter for "AAPLX" returns a
  // pump.fun impostor with $2.4k of depth; wiring that into this widget is the
  // single worst thing this product could do. The route's own mint is then
  // checked against it, so even a compromised or stale API response cannot
  // steer funds: it can only refuse the trade.
  const committed = mintFor(target.sym);
  const mismatch = committed !== undefined && committed.mint !== target.mint;
  const blocked = committed === undefined || mismatch;

  const mint = committed?.mint ?? "";
  const inputMint = target.cheap ? USDC_MINT : mint;
  const outputMint = target.cheap ? mint : USDC_MINT;
  const deepLink = `https://jup.ag/swap/${inputMint}-${outputMint}`;

  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [detail, setDetail] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (blocked) return;
    let cancelled = false;
    // No state reset here: BasisTable keys this component by mint, so a new
    // target remounts it and the initial state above is already correct.
    // Setting state in an effect body costs a cascading render for nothing.

    loadPlugin()
      .then(async (jup) => {
        if (cancelled) return;
        await jup.init({
          displayMode: "integrated",
          integratedTargetId: TARGET_ID,
          formProps: {
            swapMode: "ExactIn",
            initialInputMint: inputMint,
            initialOutputMint: outputMint,
          },
        });
        if (!cancelled) setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus("failed");
        setDetail(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      // The widget owns its own React root inside our target div. `close` is
      // the only teardown the shell exposes; the next `init` unmounts the old
      // root itself.
      window.Jupiter?.close?.();
    };
  }, [blocked, inputMint, outputMint]);

  return (
    <section
      className={styles.swapPanel}
      aria-labelledby="swap-panel-heading"
      ref={panelRef}
      tabIndex={-1}
    >
      <header className={styles.swapHead}>
        <div>
          <div className={styles.swapTitle} id="swap-panel-heading">
            {target.cheap
              ? `Buy ${target.tokenSym} with USDC`
              : `Sell ${target.tokenSym} for USDC`}
          </div>
          <p className={styles.swapSub}>
            {target.cheap
              ? `${target.tokenSym} trades below ${target.sym}, so closing the basis means USDC in and ${target.tokenSym} out.`
              : `${target.tokenSym} trades above ${target.sym}, so closing the basis means ${target.tokenSym} in and USDC out.`}{" "}
            Wallet connection, quoting, slippage and signing all happen inside Jupiter&apos;s
            own widget. This app never sees a key and never builds a transaction. The basis
            above is not a promise of profit: it can widen, and the underlying does not trade
            overnight.
          </p>
        </div>
        <button type="button" className={styles.closeBtn} onClick={onClose}>
          <CloseIcon />
          Close
        </button>
      </header>

      {blocked ? (
        <p className={`${styles.notice} ${styles.noticeDown}`} role="alert">
          <WarnIcon />
          <span className={styles.noticeBody}>
            <span>
              {mismatch
                ? `Refusing to open a swap for ${target.sym}. The API returned mint ${target.mint}, but the committed list holds ${committed?.mint}. A mint that does not match the committed one is exactly how funds reach a ticker-squatting impostor, so no widget is mounted.`
                : `Refusing to open a swap for ${target.sym}: it has no committed mint in lib/mints.ts. A mint is never resolved by symbol search here, so there is nothing safe to swap.`}
            </span>
          </span>
        </p>
      ) : (
        <>
          <p className={styles.route}>
            <span>in</span>
            <span className={styles.routeMint} title={inputMint}>
              {short(inputMint)}
            </span>
            <span aria-hidden="true">&rarr;</span>
            <span>out</span>
            <span className={styles.routeMint} title={outputMint}>
              {short(outputMint)}
            </span>
            <span>
              &middot; depth ${committed ? committed.liquidityUsd.toLocaleString("en-US") : "0"},
              floor ${LIQUIDITY_FLOOR_USD.toLocaleString("en-US")}
            </span>
          </p>

          {status === "loading" && (
            <p className={styles.notice} role="status">
              <InfoIcon />
              <span>Loading Jupiter&apos;s swap widget from plugin.jup.ag…</span>
            </p>
          )}

          {status === "failed" && (
            <p className={`${styles.notice} ${styles.noticeDown}`} role="alert">
              <WarnIcon />
              <span className={styles.noticeBody}>
                <span>The swap widget did not load, so there is nothing to trade in here.</span>
                <span className={styles.errorDetail}>{detail}</span>
                <span>
                  The pair is still tradeable on Jupiter directly, at the link below.
                </span>
              </span>
            </p>
          )}

          <div id={TARGET_ID} className={styles.widgetHost} />

          <p className={styles.deepLink}>
            <a href={deepLink} target="_blank" rel="noopener noreferrer">
              Open this pair on jup.ag
            </a>{" "}
            instead, with the same two mints pre-filled.
          </p>
        </>
      )}
    </section>
  );
}

function CloseIcon() {
  return (
    <svg
      className={styles.icon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
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
