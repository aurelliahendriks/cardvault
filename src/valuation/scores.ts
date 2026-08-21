/**
 * Three scores, deliberately not one.
 *
 * A single `cardScore` is the thing that feels clever and then ruins the tool: when it
 * moves you cannot tell whether the card got scarcer (impossible), the copy got nicer
 * (impossible without regrading), or the market moved (the only thing that actually
 * changes). So the axes stay separate and each one answers exactly one question:
 *
 *   RARITY     how scarce was this printing manufactured to be?
 *   CONDITION  how desirable is this physical copy?
 *   MARKET     how strongly is the market valuing it right now?
 *
 * The rule that keeps them honest: **rarity is a pure function of the print run and the
 * card's own structure.** Nothing about demand, price, comps, trend, player form or
 * tournament results may enter it. A /49 does not become scarcer because its player
 * scores in a final — that is `market` moving, and conflating the two is how a tracker
 * starts telling you comfortable lies about your own collection.
 *
 * Symmetrically, `market` must never read the print run directly. It reads *price*,
 * which already contains the market's own opinion of scarcity. Feeding print run into
 * both would double-count it and make scarce cards look strong even while they were
 * falling.
 */

/** Rarity bands, mirroring the UI ladder exactly. One source of truth per boundary. */
export type RarityTier =
  | 'base' | 'parallel' | 'scarce' | 'scarcer' | 'ice' | 'foil' | 'elite' | 'unique';

export interface RarityInput {
  print_run?: number | null;
  parallel_name?: string | null;
  /** Derived in SQL: Base | Base Optic | Insert | Autograph | Dual Autograph | Promo. */
  card_type?: string | null;
}

/**
 * Bands sit where the hobby already puts them — /99, /49, /25, /10, 1/1 are the numbers
 * printed on the cards, so they are the boundaries a collector expects to perceive.
 *
 * A note for later: /5 has real standing in the hobby and could reasonably split out of
 * the 2–10 band. It is deliberately *not* split yet — another rung costs visual clarity
 * across the whole ladder, and it is only worth paying once a collection actually holds
 * enough /5s to need the distinction. `SELECT COUNT(*) FROM skus s JOIN parallels p ON
 * p.id = s.parallel_id JOIN holdings h ON h.sku_id = s.id WHERE p.print_run <= 5` is the
 * number to watch.
 */
export function rarityTier(c: RarityInput): RarityTier {
  const run = c.print_run;
  if (run != null) {
    if (run === 1) return 'unique';
    if (run <= 10) return 'elite';
    if (run <= 25) return 'foil';
    if (run <= 49) return 'ice';
    if (run <= 99) return 'scarcer';
    return 'scarce';
  }
  // No serial number. An insert, a promo or an autograph is still not a base card —
  // Kaboom scoring as "base" was plainly wrong — but it cannot be ranked *above* a
  // numbered card either, because an insert ratio is not a print run and we do not know
  // it. So everything unnumbered-but-special shares the one rung above base.
  if (c.parallel_name) return 'parallel';
  if (c.card_type && c.card_type !== 'Base' && c.card_type !== 'Base Optic') return 'parallel';
  return 'base';
}

const TIER_SCORE: Record<RarityTier, number> = {
  base: 5, parallel: 16, scarce: 34, scarcer: 45,
  ice: 60, foil: 72, elite: 85, unique: 100,
};

/**
 * Supply, and nothing else. 0–100.
 *
 * Within a band the exact print run nudges the score a little, so a /150 and a /101 are
 * not identical — but never enough to cross into the next band, because the bands are
 * the part a person can actually perceive.
 */
export function rarityScore(c: RarityInput): {
  score: number; tier: RarityTier; why: string; known: true; display: 'value';
} {
  const tier = rarityTier(c);
  const base = TIER_SCORE[tier];
  const run = c.print_run ?? null;

  if (run == null) {
    return { score: base, tier, known: true, display: 'value',
             why: tier === 'base' ? 'no parallel, no serial number'
                : c.parallel_name ? 'a parallel, unnumbered'
                : `${(c.card_type ?? 'insert').toLowerCase()}, unnumbered` };
  }
  if (run === 1) return { score: 100, tier, why: 'a single copy exists', known: true, display: 'value' };

  // Position within the band, worth at most half the distance to the next band.
  const BANDS: Record<string, [number, number, number]> = {
    // tier: [low, high, next tier score]
    scarce:  [100, 400, TIER_SCORE.scarcer],
    scarcer: [50, 99, TIER_SCORE.ice],
    ice:     [26, 49, TIER_SCORE.foil],
    foil:    [11, 25, TIER_SCORE.elite],
    elite:   [2, 10, TIER_SCORE.unique],
  };
  const band = BANDS[tier];
  if (!band) return { score: base, tier, why: `print run of ${run}`, known: true, display: 'value' };

  const [low, high, next] = band;
  const clamped = Math.min(Math.max(run, low), high);
  // Scarcer = higher, so the position runs backwards through the band.
  const pos = (high - clamped) / (high - low || 1);
  const headroom = (next - base) * 0.5;
  return {
    score: round1(base + pos * headroom),
    tier,
    why: `print run of ${run}`,
    known: true, display: 'value',
  };
}

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export interface ConditionInput {
  grader?: string | null;
  grade?: string | null;
  /** Your own note on a raw card, if you recorded one. */
  condition?: string | null;
}

/**
 * How desirable this physical copy is. 0–100, plus `known`.
 *
 * A raw card is *unknown*, not average — and that distinction has to survive into the
 * UI, because "we have not assessed this" and "we assessed this as middling" are
 * different claims and only one of them is true. Raw cards therefore report a nominal
 * score with `known: false` so the UI can render it as an absence.
 */
export function conditionScore(c: ConditionInput): {
  score: number; known: boolean; label: string; why: string; display: 'value' | 'absent';
} {
  const grader = (c.grader ?? '').trim().toUpperCase();
  const raw = (c.grade ?? '').toString().trim();

  if (!grader) {
    const note = (c.condition ?? '').toLowerCase();
    // A self-reported condition is evidence, but it is not a grade, so it never scores
    // like one. The ceiling here sits below any slab on purpose.
    const own = (score: number, label: string) => ({
      score, known: false, label, why: 'ungraded; your own assessment',
      display: 'value' as const,
    });
    if (/mint|nm|near mint/.test(note)) return own(62, 'Raw — near mint (your note)');
    if (/excellent|ex\b/.test(note))    return own(52, 'Raw — excellent (your note)');
    if (/good|vg/.test(note))           return own(42, 'Raw — good (your note)');
    if (/poor|damaged|crease/.test(note)) return own(20, 'Raw — damaged (your note)');
    // No grade and no note: an absence. The UI must not draw a half-full bar here.
    return { score: 50, known: false, label: 'Raw — ungraded', display: 'absent',
             why: 'no grade on file; this is an absence, not an average' };
  }

  if (/black\s*label/i.test(raw)) {
    return { score: 100, known: true, label: `${grader} Black Label`,
             why: 'four 10 subgrades', display: 'value' };
  }
  const g = parseFloat(raw);
  if (!isFinite(g)) {
    return { score: 55, known: false, label: `${grader} — grade unclear`,
             why: 'grader recorded without a grade', display: 'absent' };
  }

  // BGS runs to 10 with half steps and a distinct 9.5 "gem mint"; PSA/SGC 10 is the
  // top. Mapping per grader rather than one curve, because a BGS 9.5 and a PSA 9.5
  // (which does not exist) are not the same claim.
  const isBgs = /^BGS|^BECKETT/.test(grader);
  const table: [number, number][] = isBgs
    ? [[10, 99], [9.5, 94], [9, 82], [8.5, 72], [8, 64], [7, 52], [6, 42], [5, 34]]
    : [[10, 97], [9, 84], [8, 70], [7, 56], [6, 46], [5, 36], [4, 28], [3, 20]];

  for (const [threshold, score] of table) {
    if (g >= threshold) {
      return { score, known: true, label: `${grader} ${raw}`, display: 'value',
               why: isBgs && g === 9.5 ? 'gem mint' : `graded ${raw} by ${grader}` };
    }
  }
  return { score: 14, known: true, label: `${grader} ${raw}`, display: 'value',
           why: `graded ${raw} by ${grader}` };
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface MarketInput {
  /** Current fair value, in AUD. */
  value_aud?: number | null;
  /** The highest fair value anywhere in the set, for placing this card on a scale. */
  top_value_aud?: number | null;
  trend_30d_pct?: number | null;
  n_comps?: number | null;
  /** Valuation confidence, 0–1. */
  confidence?: number | null;
  /** Sales per month, if velocity has been computed. */
  sales_per_month?: number | null;
}

/**
 * How strongly the market is valuing this card right now. 0–100.
 *
 * Reads price, trend, liquidity and evidence quality — never the print run. Price
 * already embodies the market's own view of scarcity, so taking the run as well would
 * count it twice and make a falling /10 look healthy.
 *
 * Value is placed on a log scale. On a linear one, a single A$24,000 Messi would flatten
 * every other card in the collection to zero, which tells you nothing about any of them.
 */
export function marketScore(m: MarketInput): {
  score: number; known: boolean; why: string; display: 'value' | 'absent';
} {
  const value = num(m.value_aud);
  const top = Math.max(num(m.top_value_aud) ?? 0, value ?? 0, 10);
  if (value == null || value <= 0) {
    return { score: 0, known: false, why: 'no price on file', display: 'absent' };
  }

  // Log placement within the set: A$5 → near 0, the set's top card → 1.
  const place = Math.log10(value + 1) / Math.log10(top + 1);
  let score = 62 * clamp01(place);

  // Trend, worth up to ±16. Capped well below the price term because a 30-day trend on
  // n=3 comps is a rumour, not a signal.
  const trend = num(m.trend_30d_pct);
  if (trend != null) score += 16 * Math.tanh(trend / 25);

  // Liquidity: something that sells weekly is worth more to *you* than something that
  // sells yearly at the same headline price.
  const spm = num(m.sales_per_month);
  if (spm != null) score += 10 * clamp01(Math.log10(spm + 1) / Math.log10(9));

  // Evidence quality. Not a bonus for being expensive — a discount for not knowing.
  const conf = num(m.confidence);
  const comps = num(m.n_comps) ?? 0;
  const evidence = conf != null ? conf : comps >= 5 ? 0.7 : comps >= 2 ? 0.45 : 0.2;
  score = score * (0.72 + 0.28 * clamp01(evidence)) + 12 * clamp01(evidence);

  const why = comps > 0
    ? `${comps} comp${comps === 1 ? '' : 's'}${trend != null ? `, ${trend > 0 ? '+' : ''}${trend.toFixed(1)}% over 30 days` : ''}`
    : 'estimated — no comps yet';
  // There is always *a* number here, even from a seed — so it shows, with the basis
  // spelled out. `known` means comp-backed, which is a different question from whether
  // we have an estimate, and conflating them printed "not assessed" over a real figure.
  return { score: round1(clamp(score, 0, 100)), known: comps > 0, why, display: 'value' };
}

/** All three at once, which is how the UI wants them. */
export function scoreCard(input: RarityInput & ConditionInput & MarketInput) {
  return {
    rarity: rarityScore(input),
    condition: conditionScore(input),
    market: marketScore(input),
  };
}

// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const clamp01 = (v: number) => clamp(v, 0, 1);
const round1 = (v: number) => Math.round(v * 10) / 10;
