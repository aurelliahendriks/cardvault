/**
 * Shadow mode: log what we believed, so it can be checked later.
 *
 * The three descriptive scores are not wired into the sell/hold arithmetic, and should
 * not be. `market_score > 72 → hold` is indefensible in a way that
 * `argmax(EV_sell_now, EV_hold, EV_grade)` is not — you can inspect the second one and
 * disagree with an assumption, which is the whole point of the tool.
 *
 * But the scores shouldn't be wasted either. So every recommendation writes a row here
 * carrying the decision, the arithmetic behind it, and the scores alongside it. Later,
 * `evaluate()` asks whether the scores contained information the EV engine was missing.
 *
 * If they did, the thing to promote into the model is the **underlying variable** —
 * momentum, sell-through, comp velocity — not the 0-100 score. A score is a presentation
 * artefact; a validated component is a model input. Keeping that distinction is what
 * stops this becoming a black box that says 83/100 → SELL.
 */

import { q, one } from '../db.js';
import { log } from '../logger.js';

/** Stamp on every row, so a later analysis knows which guess produced it. */
export const MARKET_SCORE_VERSION = 'heuristic-v1';
export const MARKET_SCORE_CALIBRATED = false;

export interface ShadowRow {
  skuId: number;
  action: string;
  urgency?: number | null;
  valueAud?: number | null;
  bestNetAud?: number | null;
  method?: string | null;
  nComps?: number | null;
  confidence?: number | null;
  rarityScore?: number | null;
  conditionScore?: number | null;
  marketScore?: number | null;
  rarityTier?: string | null;
  hypeShare?: number | null;
  baselineShare?: number | null;
  halfLifeDays?: number | null;
  retain90?: number | null;
}

/**
 * Record one decision. Idempotent per SKU per day — re-running the recommender must not
 * inflate the sample, or every "n" in a later analysis is a lie.
 */
export async function logDecision(r: ShadowRow): Promise<void> {
  try {
    await q(
      `INSERT INTO decision_log
         (sku_id, action, urgency, value_aud, best_net_aud, method, n_comps, confidence,
          rarity_score, condition_score, market_score, rarity_tier,
          market_score_version, calibrated,
          hype_share, baseline_share, half_life_days, retain_90,
          median_price_at_decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_aud)
                  FROM comps WHERE sku_id = $1 AND NOT excluded
                   AND sold_at > now() - INTERVAL '30 days'))
       ON CONFLICT (sku_id, decided_on) DO UPDATE SET
         action = EXCLUDED.action, urgency = EXCLUDED.urgency,
         value_aud = EXCLUDED.value_aud, best_net_aud = EXCLUDED.best_net_aud,
         method = EXCLUDED.method, n_comps = EXCLUDED.n_comps,
         confidence = EXCLUDED.confidence,
         rarity_score = EXCLUDED.rarity_score, condition_score = EXCLUDED.condition_score,
         market_score = EXCLUDED.market_score, rarity_tier = EXCLUDED.rarity_tier,
         hype_share = EXCLUDED.hype_share, baseline_share = EXCLUDED.baseline_share,
         half_life_days = EXCLUDED.half_life_days, retain_90 = EXCLUDED.retain_90`,
      [r.skuId, r.action, r.urgency ?? null, r.valueAud ?? null, r.bestNetAud ?? null,
       r.method ?? null, r.nComps ?? null, r.confidence ?? null,
       r.rarityScore ?? null, r.conditionScore ?? null, r.marketScore ?? null,
       r.rarityTier ?? null, MARKET_SCORE_VERSION, MARKET_SCORE_CALIBRATED,
       r.hypeShare ?? null, r.baselineShare ?? null, r.halfLifeDays ?? null,
       r.retain90 ?? null],
    );
  } catch (e: any) {
    // Logging must never break a recommendation. A missing shadow row costs a data
    // point; a thrown error costs the user their answer.
    log.debug({ skuId: r.skuId, err: e.message }, 'shadow log write failed');
  }
}

/**
 * Fill in what actually happened, for rows old enough to know.
 *
 * Forward-looking on purpose. Asking "does a high market score correlate with today's
 * price" is circular — the score is *made of* price. The only honest question is whether
 * a score frozen at time t predicted what happened after t.
 */
export async function observeOutcomes(): Promise<{ updated: number }> {
  const rows = await q<{ id: number }>(
    `UPDATE decision_log dl SET
        median_price_30d = (
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price_aud) FROM comps c
           WHERE c.sku_id = dl.sku_id AND NOT c.excluded
             AND c.sold_at >  dl.decided_at
             AND c.sold_at <= dl.decided_at + INTERVAL '30 days'),
        sales_next_30d = (
          SELECT COUNT(*)::int FROM comps c
           WHERE c.sku_id = dl.sku_id AND NOT c.excluded
             AND c.sold_at >  dl.decided_at
             AND c.sold_at <= dl.decided_at + INTERVAL '30 days'),
        median_price_60d = (
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price_aud) FROM comps c
           WHERE c.sku_id = dl.sku_id AND NOT c.excluded
             AND c.sold_at >  dl.decided_at
             AND c.sold_at <= dl.decided_at + INTERVAL '60 days'),
        sales_next_60d = (
          SELECT COUNT(*)::int FROM comps c
           WHERE c.sku_id = dl.sku_id AND NOT c.excluded
             AND c.sold_at >  dl.decided_at
             AND c.sold_at <= dl.decided_at + INTERVAL '60 days'),
        outcome_observed_at = now()
      WHERE dl.decided_at < now() - INTERVAL '30 days'
      RETURNING dl.id`,
  );
  log.info({ updated: rows.length }, 'shadow outcomes observed');
  return { updated: rows.length };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface Evaluation {
  version: string;
  calibrated: boolean;
  rows: number;
  usableRows: number;
  /** Distinct player × rarity groups. This, not row count, is the real sample size. */
  independentGroups: number;
  verdict: 'insufficient' | 'plumbing-only' | 'exploratory' | 'preliminary' | 'usable';
  guidance: string;
  spearman?: { rho: number; n: number } | null;
  buckets?: Array<{ band: string; n: number; meanForwardReturn: number }>;
  regret?: Array<{ strategy: string; meanRegretAud: number; n: number }>;
  notes: string[];
}

/**
 * How much data before an answer means anything.
 *
 * Independent observations, not rows. 300 comps that are 250 Yamal, 30 Messi and 20 Nico
 * Williams is not 300 market situations — it is roughly three, sampled repeatedly. The
 * gate counts distinct player × rarity-tier groups for exactly that reason.
 */
const GATES: Array<[number, Evaluation['verdict'], string]> = [
  [0, 'insufficient', 'Nothing logged yet. Run the recommender, then wait 30 days.'],
  [1, 'plumbing-only',
   'Enough to prove the logging and the arithmetic work. Not enough to conclude anything '
   + 'about the market — do not touch the weights.'],
  [12, 'exploratory',
   'Enough to eyeball relationships and catch sign errors. Still far too few independent '
   + 'situations to calibrate on; treat every number here as a hint.'],
  [40, 'preliminary',
   'Enough for preliminary weights, clearly labelled experimental. Time-based holdout '
   + 'only — never a random split, or future sales leak into earlier scores.'],
  [90, 'usable',
   'Enough to take a small model seriously. Compare against the dumb baselines before '
   + 'shipping any cleverness: if it cannot beat "always sell now" and "always hold" '
   + 'out of sample, the cleverness is decoration.'],
];

export async function evaluate(): Promise<Evaluation> {
  const notes: string[] = [];
  const rows = await q<{
    market_score: number | null; median_price_at_decision: number | null;
    median_price_30d: number | null; sales_next_30d: number | null;
    action: string; value_aud: number | null; retain_90: number | null;
    player: string; rarity_tier: string | null;
  }>(
    `SELECT dl.market_score, dl.median_price_at_decision, dl.median_price_30d,
            dl.sales_next_30d, dl.action, dl.value_aud, dl.retain_90,
            d.player, dl.rarity_tier
       FROM decision_log dl
       JOIN sku_detail d ON d.sku_id = dl.sku_id
      WHERE dl.market_score_version = $1`,
    [MARKET_SCORE_VERSION],
  );

  // Usable means we can compute a forward return: a price before AND a price after.
  const usable = rows.filter((r) =>
    r.market_score != null && num(r.median_price_at_decision) != null
    && num(r.median_price_at_decision)! > 0 && num(r.median_price_30d) != null);

  const groups = new Set(usable.map((r) => `${r.player}|${r.rarity_tier ?? '?'}`));
  const gate = [...GATES].reverse().find(([n]) => groups.size >= n)!;

  const ev: Evaluation = {
    version: MARKET_SCORE_VERSION,
    calibrated: MARKET_SCORE_CALIBRATED,
    rows: rows.length,
    usableRows: usable.length,
    independentGroups: groups.size,
    verdict: gate[1],
    guidance: gate[2],
    notes,
  };

  if (usable.length < 3) {
    notes.push('Fewer than three forward observations — nothing computed. This is the '
             + 'expected state until real comps accumulate.');
    return ev;
  }

  const forward = usable.map((r) => ({
    score: Number(r.market_score),
    ret: num(r.median_price_30d)! / num(r.median_price_at_decision)! - 1,
    action: r.action,
    valueAud: num(r.value_aud) ?? 0,
    retain90: num(r.retain_90) ?? 1,
  }));

  ev.spearman = { rho: spearman(forward.map((f) => f.score), forward.map((f) => f.ret)),
                  n: forward.length };

  const band = (s: number) => (s >= 70 ? '70-100' : s >= 40 ? '40-69' : '0-39');
  const byBand = new Map<string, number[]>();
  for (const f of forward) {
    const k = band(f.score);
    (byBand.get(k) ?? byBand.set(k, []).get(k)!).push(f.ret);
  }
  ev.buckets = [...byBand.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([b, xs]) => ({ band: b, n: xs.length, meanForwardReturn: round(mean(xs), 4) }));

  // Regret against deliberately stupid baselines. If the EV engine cannot beat these,
  // the engine is the problem, not the baselines.
  const regret = (choose: (f: typeof forward[number]) => 'sell' | 'hold') => {
    const rs = forward.map((f) => {
      const sellNow = 0;                          // realise today's price
      const holdOutcome = f.valueAud * f.ret;     // what waiting actually did
      const best = Math.max(sellNow, holdOutcome);
      const got = choose(f) === 'sell' ? sellNow : holdOutcome;
      return best - got;
    });
    return { meanRegretAud: round(mean(rs), 2), n: rs.length };
  };
  ev.regret = [
    { strategy: 'always sell now', ...regret(() => 'sell') },
    { strategy: 'always hold 30d', ...regret(() => 'hold') },
    { strategy: 'current EV engine',
      ...regret((f) => (/sell/.test(f.action) ? 'sell' : 'hold')) },
  ];

  notes.push('Forward returns only: the score is frozen at decision time and compared '
           + 'with what happened afterwards. Correlating a score against the price it '
           + 'was computed from would be circular.');
  notes.push('Use a time-based holdout when you do calibrate — develop on months 1-n, '
           + 'validate on month n+1. A random split leaks future sales into past scores.');
  if (groups.size < 40) {
    notes.push(`Only ${groups.size} independent player × rarity groups. Repeated sales of `
             + 'the same parallel are one market situation sampled many times, not many '
             + 'situations.');
  }
  return ev;
}

// ---------------------------------------------------------------------------

/** Spearman rank correlation, with average ranks for ties. */
export function spearman(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx, b = ry[i]! - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? round(num / Math.sqrt(dx * dy), 4) : 0;
}

export function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;                    // average rank for ties
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
