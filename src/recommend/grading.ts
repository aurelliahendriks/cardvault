import { one } from '../db.js';
import { multiplierFor } from '../valuation/engine.js';

/**
 * Grade-or-sell-raw expected value, from Australia.
 *
 * The cost side is specific and unforgiving: via an AU middleman (Slabbys,
 * Card Bot, Mana Market) the cheapest PSA tiers land around A$48-50/card
 * before return postage, so realistic all-in is A$55-70 and turnaround is
 * 4-8 months once you add consolidation and transit. Submitting direct from
 * Australia is complicated by US tariff charges on declared card value.
 *
 * The gem-rate side is where most people fool themselves. Modern Panini
 * Donruss commonly gems at 30-60%, and full-bleed inserts like Kaboom get
 * capped at 9 by centering and print lines far more often than people expect.
 * A PSA 9 frequently sells at or below 2x raw, which does not cover the fee.
 */

export interface GradeCosts {
  feeAud: number;        // all-in per card
  months: number;
  tier: string;
}

export const GRADE_TIERS: GradeCosts[] = [
  { tier: 'PSA Value Bulk (20+ cards, via AU middleman)', feeAud: 62, months: 7 },
  { tier: 'PSA Value (via AU middleman)', feeAud: 68, months: 6 },
  { tier: 'PSA Value Max', feeAud: 195, months: 2 },
  { tier: 'PSA Regular', feeAud: 215, months: 1.5 },
  { tier: 'PSA Express', feeAud: 315, months: 1 },
];

/** Gem (PSA 10) probability by section — full-bleed inserts are punished. */
export function gemRate(section: string, product: string): number {
  const s = section.toLowerCase();
  if (/kaboom/.test(s)) return 0.22;                 // full-bleed, centering nightmare
  if (/animation|zero gravity|night moves/.test(s)) return 0.30;
  if (/autograph|signature|beautiful game/.test(s)) return 0.34;  // sticker autos, edge wear
  if (/optic|prizm/.test(s)) return 0.42;
  if (/^base/.test(s)) return product === 'B' ? 0.45 : 0.48;
  return 0.38;
}

export interface GradeEv {
  verdict: 'grade' | 'sell_raw' | 'borderline';
  rawAud: number;
  gemRate: number;
  psa10Aud: number;
  psa9Aud: number;
  costAud: number;
  months: number;
  tier: string;
  /** expected value of the graded outcome, net of the fee */
  evAud: number;
  /** EV uplift over just selling it raw today, in AUD */
  upliftAud: number;
  /** uplift as a multiple of the grading cost — the number that decides it */
  upliftRatio: number;
  reasoning: string;
}

/**
 * The rule of thumb this implements: only grade when the expected PSA 10 price
 * is at least ~3x your total grading cost AND the raw card is worth roughly
 * A$150+. Below that the fee eats the spread and you've locked up capital for
 * half a year.
 */
export async function gradeEv(args: {
  rawAud: number;
  section: string;
  productCode: string;
  player: string;
  /** real PSA 10 comp if we have one; otherwise modelled */
  psa10CompAud?: number | null;
  psa9CompAud?: number | null;
}): Promise<GradeEv> {
  const { rawAud, section, productCode } = args;
  const rate = gemRate(section, productCode);

  const tier = rawAud >= 400 ? GRADE_TIERS[1]! : GRADE_TIERS[0]!;

  const psa10 = args.psa10CompAud ??
    rawAud * (await multiplierFor({
      parallel_name: null, print_run: null, grader: 'PSA', grade: 10, section,
    }));
  const psa9 = args.psa9CompAud ??
    rawAud * (await multiplierFor({
      parallel_name: null, print_run: null, grader: 'PSA', grade: 9, section,
    }));
  // Below a 9 you've usually destroyed value versus selling raw.
  const psa8OrWorse = rawAud * 0.85;

  const pNine = Math.min(0.95 - rate, (1 - rate) * 0.62);
  const pWorse = Math.max(0, 1 - rate - pNine);

  const grossEv = rate * psa10 + pNine * psa9 + pWorse * psa8OrWorse;
  const evAud = r2(grossEv - tier.feeAud);
  const upliftAud = r2(evAud - rawAud);
  const upliftRatio = tier.feeAud > 0 ? r2(upliftAud / tier.feeAud) : 0;

  // Two gates, both must pass: absolute raw value, and PSA 10 comp vs cost.
  const rawGate = rawAud >= 150;
  const compGate = psa10 >= tier.feeAud * 3;

  let verdict: GradeEv['verdict'];
  if (rawGate && compGate && upliftRatio >= 1.0) verdict = 'grade';
  else if (upliftRatio >= 0.4 && rawAud >= 100) verdict = 'borderline';
  else verdict = 'sell_raw';

  const bits: string[] = [];
  bits.push(`Raw A$${rawAud.toFixed(0)}; modelled PSA 10 A$${psa10.toFixed(0)}, PSA 9 A$${psa9.toFixed(0)}.`);
  bits.push(`Gem rate for ${section} assumed ${(rate * 100).toFixed(0)}%.`);
  bits.push(`${tier.tier}: A$${tier.feeAud} all-in, ~${tier.months} months.`);
  bits.push(`Expected value after fee A$${evAud.toFixed(0)} vs A$${rawAud.toFixed(0)} raw = ${upliftAud >= 0 ? '+' : ''}A$${upliftAud.toFixed(0)} (${upliftRatio.toFixed(2)}x the fee).`);
  if (!rawGate) bits.push(`Below the A$150 raw floor — a PSA 9 outcome here does not cover the fee.`);
  if (!compGate) bits.push(`PSA 10 comp is under 3x the grading cost, so the upside is too thin for the gem risk.`);
  if (verdict === 'grade') bits.push(`Capital is locked for ~${tier.months} months; that is the real cost, not the fee.`);

  return {
    verdict, rawAud: r2(rawAud), gemRate: rate, psa10Aud: r2(psa10), psa9Aud: r2(psa9),
    costAud: tier.feeAud, months: tier.months, tier: tier.tier,
    evAud, upliftAud, upliftRatio, reasoning: bits.join(' '),
  };
}

/** Look up a real PSA 10 comp for this card if one exists. */
export async function psaCompFor(cardId: number, grade: number): Promise<number | null> {
  const row = await one<{ fair_value_aud: number; n_comps: number }>(
    `SELECT v.fair_value_aud, v.n_comps
       FROM latest_valuation v JOIN skus s ON s.id = v.sku_id
      WHERE s.card_id = $1 AND s.grader = 'PSA' AND s.grade = $2
        AND s.parallel_id IS NULL AND v.marketplace_code IS NULL AND v.n_comps > 0
      ORDER BY v.n_comps DESC LIMIT 1`,
    [cardId, grade],
  );
  return row?.fair_value_aud ?? null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
