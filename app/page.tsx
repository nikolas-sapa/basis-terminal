import { CrossVenue } from "@/components/CrossVenue";
import { PreIpoTable } from "@/components/PreIpoTable";
import { Provenance } from "@/components/Provenance";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.masthead}>
          <h1>Basis</h1>
          <p>
            Every tokenized stock on Solana trades at a price that is not the price of the
            thing it tracks. This terminal shows the gap, split by whether that gap is
            actually tradeable. Tier 1 is a listed equity against its own live underlying.
            Tier 2, below, is a pre-IPO token against a mark neither venue documents, which
            is relative value and never arbitrage.
          </p>
        </header>

        {/* Tier 1 (listed equities, tradeable basis) mounts above this line. */}

        <PreIpoTable />
        <CrossVenue />
        <Provenance />
      </main>
    </div>
  );
}
