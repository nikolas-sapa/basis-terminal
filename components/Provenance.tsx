import styles from "./tier2.module.css";

// Verbatim from the spec's provenance section. These two sentences are the only
// honest thing that can be said about where Tier 2 marks come from, and they are
// the reason no row above carries an action.
const NOTES = [
  "Tessera marks are hand-set and did not move across repeated polling; Tessera's own proof-of-reserve publishes asset counts, explicitly not dollar valuations, attested approximately monthly.",
  "PreStocks marks update automatically from a source the operator does not document.",
];

export function Provenance() {
  return (
    <section className={styles.section} aria-labelledby="provenance-heading">
      <header className={styles.head}>
        <div>
          <div className={styles.title}>
            <h2 className={styles.h2} id="provenance-heading">
              Provenance
            </h2>
            <span className={styles.tier}>TIER 2 &middot; METHODOLOGY</span>
          </div>
          <p className={styles.sub}>
            Neither pre-IPO venue documents its pricing methodology. Everything below was
            established by polling the two public endpoints directly.
          </p>
        </div>
      </header>

      <ul className={styles.notes}>
        {NOTES.map((note, i) => (
          <li key={note} className={styles.note}>
            <span className={styles.noteMark} aria-hidden="true">
              [{i + 1}]
            </span>
            <span>{note}</span>
          </li>
        ))}
      </ul>

      <ul className={styles.notes}>
        <li className={styles.note}>
          <span className={styles.noteMark} aria-hidden="true">
            &rarr;
          </span>
          <span>
            Sources: <code>prestocks.com/api/prestocks</code> and{" "}
            <code>rest-api.tessera.pe/v1/public/token-details</code>, both fetched server-side.
          </span>
        </li>
      </ul>
    </section>
  );
}
