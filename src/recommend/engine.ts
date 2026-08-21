import { callAi } from '../ai/client.js';
import { cfg } from '../config.js';
import { q, one } from '../db.js';
import { log } from '../logger.js';
import { computeVelocity } from '../valuation/engine.js';
import { scoreCard } from '../valuation/scores.js';
import { logDecision } from '../valuation/shadow.js';
import { rankCommunities, shouldLot } from './community.js';
import { gradeEv, psaCompFor, type GradeEv } from './grading.js';
import { timingView, type TimingView } from './timing.js';
import { rankVenues, type VenueRank } from './venue.js';

export type Action = 'sell_now' | 'sell_soon' | 'hold' | 'grade_then_sell' | 'lot_it' | 'keep_watching';

export interface Recommendation {
  skuId: number;
  label: string;
  action: Action;
  urgency: number;
  score: number;
  valueAud: number;
  bestVenue: VenueRank | null;
  runnerUp: VenueRank | null;
  venueLadder: VenueRank[];
  communities: Awaited<ReturnType<typeof rankCommunities>>;
  gradeEv: GradeEv | null;
  timing: TimingView;
  velocity: { salesPerDay: number | null; daysToSell: number | null; sellThrough: number | null };
  lot: { lot: boolean; why: string };
  dataQuality: { nComps: number; method: string; confidence: number };
  reasoning: string;
}

/**
 * Build a recommendation for one SKU.
 *
 * Order matters here. Value first, because everything downstream is a function
 * of it. Then timing, because it sets urgency. Then venues and communities,
 * which are urgency-sensitive. Grading last, because it only makes sense once
 * you know the raw value and how fast the raw value is decaying — a card worth
 * grading in a stable market is often not worth grading when it will shed 30%
 * during the six months it spends in a queue.
 */
export async function recommendSku(skuId: number, opts: { useAi?: boolean } = {}): Promise<Recommendation | null> {
  const d = await one<{
    sku_id: number; label: string; card_id: number; player: string; team: string | null;
    section: string; subset: string; product_code: string; hot: boolean;
    parallel_name: string | null; grader: string | null; grade: number | null;
    seed_est_aud: number | null; print_run: number | null; card_type: string | null;
  }>(`SELECT * FROM sku_detail WHERE sku_id = $1`, [skuId]);
  if (!d) return null;

  const v = await one<{
    fair_value_aud: number; n_comps: number; method: string; confidence: number;
    trend_30d_pct: number | null;
  }>(
    `SELECT fair_value_aud, n_comps, method, confidence, trend_30d_pct
       FROM latest_valuation WHERE sku_id = $1 AND marketplace_code IS NULL`,
    [skuId],
  );

  const valueAud = Number(v?.fair_value_aud ?? d.seed_est_aud ?? 0);
  if (valueAud <= 0) return null;

  const vel = await computeVelocity(skuId, null, 30);

  const timing = timingView({
    player: d.player, team: d.team, subset: d.subset, hot: d.hot,
    valueAud, trend30dPct: v?.trend_30d_pct ?? null,
    // Scarcity feeds hype *exposure*, not the decay rate. Trading frequency feeds the
    // uncertainty band. See src/recommend/timing.ts for why that distinction matters.
    printRun: d.print_run ?? null, parallelName: d.parallel_name ?? null,
    cardType: d.card_type ?? null, grader: d.grader ?? null,
    salesPerMonth: vel.salesPerDay != null ? Number(vel.salesPerDay) * 30 : null,
  });

  const lot = shouldLot({ valueAud, salesPerDay: vel.salesPerDay, section: d.section });

  const venueLadder = await rankVenues({
    skuId, globalValueAud: valueAud, team: d.team, player: d.player, section: d.section,
    useAds: valueAud >= 50,
  });
  const bestVenue = venueLadder[0] ?? null;
  const runnerUp = venueLadder[1] ?? null;

  const communities = await rankCommunities({
    valueAud, section: d.section, team: d.team, player: d.player,
    isGraded: d.grader != null, suggestLot: lot.lot, urgency: timing.urgency,
  });

  // Grading only gets evaluated for raw cards worth looking at.
  let gEv: GradeEv | null = null;
  if (!d.grader && valueAud >= 80) {
    const psa10 = await psaCompFor(d.card_id, 10);
    const psa9 = await psaCompFor(d.card_id, 9);
    gEv = await gradeEv({
      rawAud: valueAud, section: d.section, productCode: d.product_code,
      player: d.player, psa10CompAud: psa10, psa9CompAud: psa9,
    });
    // Discount the graded upside by the decay expected during the wait. This is
    // the check most grading calculators skip, and it flips a lot of verdicts
    // in a post-tournament market.
    const waitDays = gEv.months * 30;
    const decayFactor = Math.pow(timing.retain90, waitDays / 90);
    const decayedEv = gEv.evAud * decayFactor;
    if (gEv.verdict === 'grade' && decayedEv < valueAud * 1.15) {
      gEv = {
        ...gEv,
        verdict: 'borderline',
        reasoning:
          gEv.reasoning +
          ` BUT the card is projected to retain only ${(decayFactor * 100).toFixed(0)}% of today's value over the ~${gEv.months} months in the queue, ` +
          `dropping the graded EV to about A$${decayedEv.toFixed(0)}. The grading maths works; the calendar does not.`,
      };
    }
  }

  // --- pick the action ---------------------------------------------------
  const action = decideAction({ valueAud, timing, gEv, lot, confidence: v?.confidence ?? 0.1 });

  // Score is for sorting a "what should I do this week" list: how much money is
  // actually at stake in acting on this card.
  const score = r2(
    (bestVenue?.netAud ?? valueAud) * (0.25 + timing.urgency) +
    timing.cost90Aud * 1.5 +
    (gEv?.upliftAud ?? 0) * 0.3,
  );

  const deterministic = writeReasoning({ d, valueAud, v, timing, bestVenue, runnerUp, communities, gEv, lot, vel, action });

  // Shadow mode: the three descriptive scores are logged beside the decision and
  // influence none of it. They earn their way into the arithmetic later, by predicting
  // something, or they stay diagnostics. See src/valuation/shadow.ts.
  const shadowScores = scoreCard({
    print_run: d.print_run, parallel_name: d.parallel_name, card_type: d.card_type,
    grader: d.grader, grade: d.grade as any,
    value_aud: valueAud, top_value_aud: null,
    trend_30d_pct: v?.trend_30d_pct ?? null, n_comps: v?.n_comps ?? 0,
    confidence: v?.confidence ?? null,
    sales_per_month: vel.salesPerDay != null ? Number(vel.salesPerDay) * 30 : null,
  });
  void logDecision({
    skuId, action, urgency: timing.urgency, valueAud,
    bestNetAud: bestVenue?.netAud ?? null,
    method: v?.method ?? 'seed', nComps: v?.n_comps ?? 0, confidence: v?.confidence ?? null,
    rarityScore: shadowScores.rarity.score,
    conditionScore: shadowScores.condition.display === 'absent' ? null : shadowScores.condition.score,
    marketScore: shadowScores.market.score,
    rarityTier: shadowScores.rarity.tier,
    hypeShare: timing.model.hypeShare, baselineShare: timing.model.baselineShare,
    halfLifeDays: timing.halfLifeDays, retain90: timing.retain90,
  });

  let reasoning = deterministic;
  if (opts.useAi !== false && valueAud >= 100) {
    const polished = await aiReasoning({ label: d.label, deterministic, action });
    if (polished) reasoning = polished;
  }

  const rec: Recommendation = {
    skuId, label: d.label, action, urgency: timing.urgency, score, valueAud,
    bestVenue, runnerUp, venueLadder, communities, gradeEv: gEv, timing,
    velocity: { salesPerDay: vel.salesPerDay, daysToSell: vel.daysToSell, sellThrough: vel.sellThrough },
    lot,
    dataQuality: { nComps: v?.n_comps ?? 0, method: v?.method ?? 'seed', confidence: v?.confidence ?? 0.1 },
    reasoning,
  };

  await saveRecommendation(rec);
  return rec;
}

function decideAction(a: {
  valueAud: number; timing: TimingView; gEv: GradeEv | null;
  lot: { lot: boolean }; confidence: number;
}): Action {
  if (a.confidence < 0.2 && a.valueAud >= 150) return 'keep_watching';
  if (a.gEv?.verdict === 'grade') return 'grade_then_sell';
  if (a.lot.lot && a.valueAud < 25) return 'lot_it';
  if (a.timing.urgency >= 0.6) return 'sell_now';
  if (a.timing.urgency >= 0.35) return 'sell_soon';
  return 'hold';
}

function writeReasoning(a: any): string {
  const { d, valueAud, v, timing, bestVenue, runnerUp, communities, gEv, lot, vel, action } = a;
  const lines: string[] = [];

  const ACTIONS: Record<Action, string> = {
    sell_now: 'SELL NOW',
    sell_soon: 'SELL SOON',
    hold: 'HOLD',
    grade_then_sell: 'GRADE, THEN SELL',
    lot_it: 'BUNDLE INTO A LOT',
    keep_watching: 'NEED BETTER DATA',
  };
  lines.push(`${ACTIONS[action as Action]} — ${d.label}, valued at A$${valueAud.toFixed(2)}.`);

  // data quality first: everything below is only as good as this
  if (!v || v.method !== 'comps') {
    lines.push(`⚠ No real sold comps for this exact version — the value is a ${v?.method ?? 'seed'} estimate. Verify against eBay sold listings before acting on anything over A$100.`);
  } else if (v.n_comps < 4) {
    lines.push(`Only ${v.n_comps} sold comp${v.n_comps === 1 ? '' : 's'} in the window, so treat the figure as a range, not a price.`);
  } else {
    lines.push(`Backed by ${v.n_comps} sold comps (confidence ${(Number(v.confidence) * 100).toFixed(0)}%).`);
  }

  lines.push(`Timing: ${timing.note}`);

  if (bestVenue) {
    lines.push(
      `Best net: ${bestVenue.name} at about A$${bestVenue.netAud.toFixed(2)} on an expected A$${bestVenue.expectedGrossAud.toFixed(2)} gross ` +
      `(you keep ${(bestVenue.keepRate * 100).toFixed(0)}%).`,
    );
    if (runnerUp) {
      const gap = bestVenue.netAud - runnerUp.netAud;
      lines.push(
        gap < Math.max(2, bestVenue.netAud * 0.05)
          ? `${runnerUp.name} is effectively tied (A$${runnerUp.netAud.toFixed(2)}) — pick on convenience, not price.`
          : `Next best is ${runnerUp.name} at A$${runnerUp.netAud.toFixed(2)}, so the venue choice is worth about A$${gap.toFixed(2)}.`,
      );
    }
    if (bestVenue.belowBreakEven) {
      lines.push(`⚠ This card is below break-even on ${bestVenue.name} once postage and the fixed fee are counted.`);
    }
    if (bestVenue.requiresLocalEntity) {
      lines.push(`⚠ ${bestVenue.name} needs a local address/bank or a proxy service — the net figure is best-case.`);
    }
  }

  if (communities?.length) {
    const top = communities[0];
    lines.push(`Best community: ${top.name}${top.region ? ` (${top.region})` : ''} — ${top.reasons[0] ?? ''}`);
    if (top.warnings?.length) lines.push(`  ⚠ ${top.warnings[0]}`);
    if (communities[1]) lines.push(`Backup: ${communities[1].name}.`);
  }

  if (lot.lot) lines.push(`Lot strategy: ${lot.why}`);

  if (vel.salesPerDay != null && vel.salesPerDay > 0) {
    lines.push(`Liquidity: about ${vel.salesPerDay.toFixed(2)} sales/day observed${vel.daysToSell ? `, so roughly ${vel.daysToSell} days to a sale at market` : ''}.`);
  } else {
    lines.push(`Liquidity: no observed sales in the last 30 days — expect to wait, or price under market to force it.`);
  }

  if (gEv) lines.push(`Grading: ${gEv.verdict.replace('_', ' ')}. ${gEv.reasoning}`);

  return lines.join('\n');
}

const AI_SYSTEM = `You are rewriting a trading-card sell recommendation for the collector who owns it.

Rules:
- Keep every number, ticker, marketplace name and warning from the input. Do not invent figures.
- Lead with the action and the single most decision-relevant fact.
- Be direct about uncertainty. If the input says the comp data is thin, say so plainly.
- No hype, no "great news", no emoji, no financial-advice disclaimers.
- 4-7 short sentences of plain prose. No headings, no bullet lists.
- Australian seller, prices in AUD.`;

async function aiReasoning(a: { label: string; deterministic: string; action: Action }): Promise<string | null> {
  const res = await callAi({
    model: cfg.AI_MODEL,
    system: AI_SYSTEM,
    user: `CARD: ${a.label}\nACTION: ${a.action}\n\nANALYSIS:\n${a.deterministic}`,
    maxTokens: 500,
    temperature: 0.2,
    purpose: 'recommend',
  });
  return res?.text?.trim() || null;
}

async function saveRecommendation(r: Recommendation): Promise<void> {
  await q(
    `INSERT INTO recommendations
       (sku_id, as_of, action, urgency, best_marketplace_code, best_net_aud,
        runner_up_code, runner_up_net_aud, venue_ladder, communities, grade_ev,
        timing, score, reasoning, model)
     VALUES ($1, date_trunc('hour', now()), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (sku_id, as_of) DO UPDATE SET
       action = EXCLUDED.action, urgency = EXCLUDED.urgency,
       best_marketplace_code = EXCLUDED.best_marketplace_code,
       best_net_aud = EXCLUDED.best_net_aud, runner_up_code = EXCLUDED.runner_up_code,
       runner_up_net_aud = EXCLUDED.runner_up_net_aud, venue_ladder = EXCLUDED.venue_ladder,
       communities = EXCLUDED.communities, grade_ev = EXCLUDED.grade_ev,
       timing = EXCLUDED.timing, score = EXCLUDED.score, reasoning = EXCLUDED.reasoning`,
    [r.skuId, r.action, r.urgency, r.bestVenue?.marketplaceCode ?? null, r.bestVenue?.netAud ?? null,
     r.runnerUp?.marketplaceCode ?? null, r.runnerUp?.netAud ?? null,
     JSON.stringify(r.venueLadder), JSON.stringify(r.communities),
     r.gradeEv ? JSON.stringify(r.gradeEv) : null, JSON.stringify(r.timing),
     r.score, r.reasoning, cfg.AI_MODEL],
  );
}

/** Recommend across everything you hold, most money-at-stake first. */
export async function recommendPortfolio(opts: { limit?: number; useAi?: boolean } = {}) {
  const rows = await q<{ sku_id: number }>(
    `SELECT h.sku_id FROM holdings h
       LEFT JOIN latest_valuation v ON v.sku_id = h.sku_id AND v.marketplace_code IS NULL
      WHERE h.qty > 0
      ORDER BY COALESCE(h.price_override_aud, v.fair_value_aud, 0) * h.qty DESC
      LIMIT $1`,
    [opts.limit ?? 500],
  );
  const out: Recommendation[] = [];
  for (const { sku_id } of rows) {
    try {
      const r = await recommendSku(sku_id, { useAi: opts.useAi });
      if (r) out.push(r);
    } catch (e: any) {
      log.error({ skuId: sku_id, err: e.message }, 'recommend failed');
    }
  }
  log.info({ n: out.length }, 'portfolio recommendations complete');
  return out.sort((a, b) => b.score - a.score);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
