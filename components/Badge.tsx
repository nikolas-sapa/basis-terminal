import styles from "./badge.module.css";

export type Tone = "rich" | "cheap" | "neutral" | "accent";

const TONE_CLASS: Record<Tone, string> = {
  rich: styles.rich,
  cheap: styles.cheap,
  neutral: "",
  accent: styles.accent,
};

export function Badge({
  tone = "neutral",
  dot = false,
  title,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  /** Always supplied for a badge that abbreviates something. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${TONE_CLASS[tone]}`} title={title}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * RICH / CHEAP / FAIR, coloured red / green / neutral.
 *
 * The verdict arrives from the route as a plain string, so an unrecognised
 * value renders in the neutral tone rather than being coerced into a direction.
 * Colouring an unknown verdict green would invent a trade.
 */
export function VerdictBadge({ verdict, bps }: { verdict: string; bps: number }) {
  const tone: Tone = verdict === "RICH" ? "rich" : verdict === "CHEAP" ? "cheap" : "neutral";
  const magnitude = `${Math.abs(bps)} bps`;
  const title =
    verdict === "RICH"
      ? `Token trades ${magnitude} above its underlying`
      : verdict === "CHEAP"
        ? `Token trades ${magnitude} below its underlying`
        : verdict === "FAIR"
          ? `Within 25 bps of the underlying, ${magnitude} apart`
          : `Unrecognised verdict "${verdict}" at ${magnitude}`;
  return (
    <Badge tone={tone} title={title}>
      {verdict}
    </Badge>
  );
}
