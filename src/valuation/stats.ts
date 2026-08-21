/**
 * Robust price statistics for thin, dirty comp sets.
 *
 * Card comps are the worst case for a naive mean: n is often 3-8, the
 * distribution is right-skewed (one idiot pays 4x), and a single mismatched
 * listing can move an average by 200%. Everything here is chosen to survive
 * that: median as the centre, MAD for spread, and recency weighting so a
 * post-World-Cup market that's falling 5%/week doesn't get priced off April sales.
 */

export interface Comp {
  priceAud: number;
  soldAt: Date;
  /** source trust 0..1 */
  weight?: number;
  confidence?: number;
}

export interface PriceStats {
  n: number;
  nUsed: number;
  median: number;
  trimmedMean: number;
  p25: number;
  p75: number;
  low: number;
  high: number;
  /** recency-weighted centre — the number to actually show */
  fairValue: number;
  /** MAD / median: 0.1 = tight, >0.6 = don't trust this */
  volatility: number;
  outliers: number[];
  confidence: number;
}

export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export const median = (xs: number[]): number => quantile([...xs].sort((a, b) => a - b), 0.5);

/** Median absolute deviation, scaled to be comparable to a standard deviation. */
export function mad(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Modified z-score outlier rejection. Chosen over IQR because IQR is unusable
 * at n<8, and over standard z-scores because the mean and SD are exactly what
 * the outliers have already corrupted.
 *
 * Threshold 3.5 is the conventional value; we loosen it at very small n where
 * MAD is unstable, and never reject more than 30% of the set.
 */
export function rejectOutliers(
  xs: number[],
  threshold = 3.5,
): { keptIdx: number[]; removedIdx: number[] } {
  const all = xs.map((_, i) => i);
  if (xs.length < 4) return { keptIdx: all, removedIdx: [] };

  const m = median(xs);
  const scale = mad(xs);           // already scaled to a sigma estimate

  let scored: Array<{ i: number; z: number }>;
  let t: number;

  if (scale === 0) {
    // MAD collapses to zero whenever more than half the sales are at the same
    // price — which is the NORMAL case for cheap base cards (five sales at
    // A$4.00 and one mismatched A$400 listing). A z-score is undefined here, so
    // fall back to a ratio test against the median: card prices are
    // multiplicatively distributed, so "3x off the median" is the meaningful
    // notion of far away, not "3 sigma".
    if (m === 0) return { keptIdx: all, removedIdx: [] };
    if (xs.every((x) => x === xs[0])) return { keptIdx: all, removedIdx: [] };
    scored = xs.map((x, i) => ({ i, z: Math.max(x / m, m / Math.max(x, 1e-9)) }));
    t = 3;
  } else {
    // MAD is unstable below n=6, so loosen the gate rather than throw away
    // legitimate sales from an already-thin comp set.
    t = xs.length < 6 ? threshold * 1.6 : threshold;
    scored = xs.map((x, i) => ({ i, z: Math.abs((x - m) / scale) }));
  }

  let flagged = scored.filter((s) => s.z > t);

  // Never discard more than 30% of the evidence, however weird it looks.
  const maxRemove = Math.max(1, Math.floor(xs.length * 0.3));
  if (flagged.length > maxRemove) {
    flagged = [...flagged].sort((a, b) => b.z - a.z).slice(0, maxRemove);
  }

  const removed = new Set(flagged.map((s) => s.i));
  return {
    keptIdx: all.filter((i) => !removed.has(i)),
    removedIdx: [...removed].sort((a, b) => a - b),
  };
}

/**
 * Exponential recency weight. halfLifeDays=30 means a 30-day-old sale counts
 * half as much as one from today.
 *
 * 30 days is deliberate for the post-tournament window: the 2026 final was
 * 19 July 2026 and non-icon cards historically bleed 20-40% over the following
 * months, so a 90-day flat average would systematically overprice your
 * collection right now.
 */
export function recencyWeight(soldAt: Date, halfLifeDays = 30, now = new Date()): number {
  const days = Math.max(0, (now.getTime() - soldAt.getTime()) / 86400_000);
  return Math.pow(0.5, days / halfLifeDays);
}

export function computeStats(comps: Comp[], opts: { halfLifeDays?: number; now?: Date } = {}): PriceStats {
  const now = opts.now ?? new Date();
  const halfLife = opts.halfLifeDays ?? 30;

  const clean = comps.filter((c) => Number.isFinite(c.priceAud) && c.priceAud > 0);
  if (!clean.length) {
    return { n: 0, nUsed: 0, median: 0, trimmedMean: 0, p25: 0, p75: 0, low: 0, high: 0,
             fairValue: 0, volatility: 0, outliers: [], confidence: 0 };
  }

  // Work on indices so duplicate prices are handled exactly (three sales at
  // A$4.00 must not collapse into one).
  const { keptIdx, removedIdx } = rejectOutliers(clean.map((c) => c.priceAud));
  const used = keptIdx.map((i) => clean[i]!);
  const removed = removedIdx.map((i) => clean[i]!.priceAud);
  const prices = used.map((c) => c.priceAud);
  const sorted = [...prices].sort((a, b) => a - b);

  const med = quantile(sorted, 0.5);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);

  // 20% trimmed mean
  const trimN = Math.floor(sorted.length * 0.2);
  const trimmed = sorted.slice(trimN, sorted.length - trimN);
  const trimmedMean = trimmed.length
    ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length
    : med;

  // recency- and trust-weighted centre
  let wSum = 0, vSum = 0;
  for (const c of used) {
    const w = recencyWeight(c.soldAt, halfLife, now) * (c.weight ?? 1) * (c.confidence ?? 1);
    wSum += w;
    vSum += w * c.priceAud;
  }
  const weighted = wSum > 0 ? vSum / wSum : med;

  // Blend toward the median as n shrinks: at n=1 trust nothing but the point,
  // at n>=10 trust the weighted figure.
  const trust = Math.min(1, used.length / 10);
  const fairValue = weighted * trust + med * (1 - trust);

  const scale = mad(prices);
  const volatility = med > 0 ? scale / med : 0;

  // Confidence: sample size, agreement, and freshness all have to hold up.
  const nScore = Math.min(1, Math.log10(used.length + 1) / Math.log10(11));
  const agreeScore = Math.max(0, 1 - Math.min(1, volatility / 0.8));
  const newest = Math.max(...used.map((c) => c.soldAt.getTime()));
  const ageDays = (now.getTime() - newest) / 86400_000;
  const freshScore = Math.max(0, 1 - ageDays / 120);
  const confidence = round3(0.45 * nScore + 0.35 * agreeScore + 0.20 * freshScore);

  return {
    n: clean.length,
    nUsed: used.length,
    median: r2(med),
    trimmedMean: r2(trimmedMean),
    p25: r2(p25),
    p75: r2(p75),
    low: r2(sorted[0] ?? 0),
    high: r2(sorted[sorted.length - 1] ?? 0),
    fairValue: r2(fairValue),
    volatility: round3(volatility),
    outliers: removed.map(r2),
    confidence,
  };
}

/**
 * Trend: rolling median now vs `days` ago, using only comps that existed then.
 * Returns % change, or null when either window is too thin to mean anything.
 */
export function trendPct(comps: Comp[], days: number, now = new Date()): number | null {
  const cut = now.getTime() - days * 86400_000;
  const recent = comps.filter((c) => c.soldAt.getTime() >= cut).map((c) => c.priceAud);
  const older = comps.filter((c) => c.soldAt.getTime() < cut).map((c) => c.priceAud);
  if (recent.length < 3 || older.length < 3) return null;
  const a = median(older), b = median(recent);
  if (a <= 0) return null;
  return round3(((b - a) / a) * 100);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
