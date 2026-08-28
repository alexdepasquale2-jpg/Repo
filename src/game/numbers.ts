const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

/** Compact number for HUD use: 1.23K, 4.5M, 1.00e42. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  if (n < 0) return `-${fmt(-n)}`;
  if (n < 1000) return n < 10 && !Number.isInteger(n) ? n.toFixed(1) : Math.floor(n).toString();

  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIXES.length) return n.toExponential(2);

  const scaled = n / 1000 ** tier;
  return `${scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : Math.floor(scaled)}${SUFFIXES[tier]}`;
}

/** Seconds as a coarse duration: 45s, 12m, 3h 20m. */
export function fmtTime(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Geometric price ladder — the standard incremental curve, where each copy
 * costs `growth`x the last. Kept exact rather than rounded so long ladders do
 * not drift.
 */
export function costOf(base: number, growth: number, owned: number): number {
  return base * growth ** owned;
}
