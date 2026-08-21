import { q, one } from '../db.js';
import { log } from '../logger.js';
import { printRunFromParallelName } from '../match/titleParse.js';
import { computeStats, trendPct, type Comp } from './stats.js';

const WINDOW_DAYS = 120;

/**
 * Post-tournament decay half-life, in days, by how iconic the player is.
 *
 * The 2026 final was 19 July 2026. History after every World Cup: tournament
 * stars give back 20-40% over the following months, while genuine icons barely
 * move. That asymmetry is why one global half-life would be wrong — it would
 * overprice the Moras and underprice the Messis.
 */
const ICONS = /\b(messi|ronaldo|cristiano|mbappe|neymar|haaland|yamal)\b/i;
const WC_FINAL = new Date('2026-07-19T00:00:00Z');

function halfLifeFor(player: string, section: string): number {
  if (ICONS.test(player)) return 75;                    // icons hold; weight older sales more
  if (/kaboom|signature|autograph/i.test(section)) return 55;
  return 30;                                            // everything else: price off recent sales
}

export interface ValuationInput {
  skuId: number;
  marketplaceCode: string | null;   // null = global blend
  windowDays?: number;
}

export interface ValuationOut {
  skuId: number;
  marketplaceCode: string | null;
  nComps: number;
  fairValueAud: number;
  medianAud: number;
  lowAud: number;
  highAud: number;
  p25Aud: number;
  p75Aud: number;
  trend30dPct: number | null;
  trend90dPct: number | null;
  volatility: number;
  method: 'comps' | 'parallel_mult' | 'tier_avg' | 'seed';
  confidence: number;
}

async function loadComps(skuId: number, marketplaceCode: string | null, windowDays: number): Promise<Comp[]> {
  const rows = await q<{ price_aud: number; sold_at: Date; trust: number; conf: number }>(
    `SELECT c.price_aud, c.sold_at, s.trust_weight AS trust, c.match_confidence AS conf
       FROM comps c
       JOIN listings l ON l.id = c.listing_id
       JOIN sources s  ON s.code = l.source_code
      WHERE c.sku_id = $1
        AND NOT c.excluded
        AND c.is_sold
        AND c.sold_at >= now() - ($2 || ' days')::interval
        AND ($3::text IS NULL OR c.marketplace_code = $3)
      ORDER BY c.sold_at DESC
      LIMIT 500`,
    [skuId, String(windowDays), marketplaceCode],
  );
  return rows.map((r) => ({
    priceAud: Number(r.price_aud),
    soldAt: new Date(r.sold_at),
    weight: Number(r.trust ?? 1),
    confidence: Number(r.conf ?? 1),
  }));
}

/**
 * Value one SKU. Falls back down a ladder when comps run out:
 *   comps -> parallel multiple off the base card -> section tier average -> seed
 * The `method` and `confidence` fields make the fallback visible in the UI
 * rather than pretending a guess is a price.
 */
export async function valueSku(input: ValuationInput): Promise<ValuationOut | null> {
  const { skuId } = input;
  const windowDays = input.windowDays ?? WINDOW_DAYS;

  const meta = await one<{
    card_id: number; player: string; section: string; product_code: string;
    parallel_name: string | null; print_run: number | null;
    grader: string | null; grade: number | null; seed_est_aud: number | null;
  }>(
    `SELECT card_id, player, section, product_code, parallel_name, print_run, grader, grade, seed_est_aud
       FROM sku_detail WHERE sku_id = $1`, [skuId],
  );
  if (!meta) return null;

  const halfLife = halfLifeFor(meta.player, meta.section);
  const comps = await loadComps(skuId, input.marketplaceCode, windowDays);

  // --- tier 1: real comps -------------------------------------------------
  if (comps.length >= 2) {
    const st = computeStats(comps, { halfLifeDays: halfLife });
    return {
      skuId,
      marketplaceCode: input.marketplaceCode,
      nComps: st.nUsed,
      fairValueAud: st.fairValue,
      medianAud: st.median,
      lowAud: st.low,
      highAud: st.high,
      p25Aud: st.p25,
      p75Aud: st.p75,
      trend30dPct: trendPct(comps, 30),
      trend90dPct: trendPct(comps, 90),
      volatility: st.volatility,
      method: 'comps',
      confidence: st.confidence,
    };
  }

  // A single sale is a data point, not a market. Report it, but say so.
  if (comps.length === 1) {
    const p = comps[0]!.priceAud;
    return {
      skuId, marketplaceCode: input.marketplaceCode, nComps: 1,
      fairValueAud: p, medianAud: p, lowAud: p, highAud: p, p25Aud: p, p75Aud: p,
      trend30dPct: null, trend90dPct: null, volatility: 0,
      method: 'comps', confidence: 0.28,
    };
  }

  // --- tier 2: multiply off the base card --------------------------------
  if (meta.parallel_name || meta.grader) {
    const baseVal = await one<{ fair_value_aud: number; confidence: number }>(
      `SELECT v.fair_value_aud, v.confidence
         FROM latest_valuation v
         JOIN skus s ON s.id = v.sku_id
        WHERE s.card_id = $1 AND s.parallel_id IS NULL AND s.grader IS NULL
          AND v.marketplace_code IS NULL
        LIMIT 1`,
      [meta.card_id],
    );
    const base = baseVal?.fair_value_aud ?? meta.seed_est_aud;
    if (base && base > 0) {
      const mult = await multiplierFor(meta);
      const v = Math.round(base * mult * 100) / 100;
      return {
        skuId, marketplaceCode: input.marketplaceCode, nComps: 0,
        fairValueAud: v, medianAud: v, lowAud: Math.round(v * 0.6 * 100) / 100,
        highAud: Math.round(v * 1.7 * 100) / 100, p25Aud: v * 0.8, p75Aud: v * 1.25,
        trend30dPct: null, trend90dPct: null, volatility: 0.5,
        method: 'parallel_mult',
        confidence: Math.min(0.35, (baseVal?.confidence ?? 0.2) * 0.6),
      };
    }
  }

  // --- tier 3: section tier average --------------------------------------
  const tier = await one<{ med: number; n: number }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v.fair_value_aud) AS med, COUNT(*)::int AS n
       FROM latest_valuation v
       JOIN sku_detail d ON d.sku_id = v.sku_id
      WHERE d.product_code = $1 AND d.section = $2
        AND d.parallel_name IS NULL AND d.grader IS NULL
        AND v.marketplace_code IS NULL AND v.n_comps > 0`,
    [meta.product_code, meta.section],
  );
  if (tier?.med && tier.n >= 3) {
    const v = Math.round(Number(tier.med) * 100) / 100;
    return {
      skuId, marketplaceCode: input.marketplaceCode, nComps: 0,
      fairValueAud: v, medianAud: v, lowAud: v * 0.5, highAud: v * 2,
      p25Aud: v * 0.7, p75Aud: v * 1.4,
      trend30dPct: null, trend90dPct: null, volatility: 0.7,
      method: 'tier_avg', confidence: 0.18,
    };
  }

  // --- tier 4: the hand-seeded estimate ---------------------------------
  if (meta.seed_est_aud != null) {
    const v = Number(meta.seed_est_aud);
    return {
      skuId, marketplaceCode: input.marketplaceCode, nComps: 0,
      fairValueAud: v, medianAud: v, lowAud: v * 0.5, highAud: v * 2,
      p25Aud: v * 0.7, p75Aud: v * 1.4,
      trend30dPct: null, trend90dPct: null, volatility: 0,
      method: 'seed', confidence: 0.12,
    };
  }

  return null;
}

/**
 * Multiplier for a parallel/grade relative to the raw base card.
 *
 * Print-run scaling is sub-linear on purpose: a /10 is not 10x a /100. The
 * relationship in modern soccer product is closer to a power law with an
 * exponent well under 1, plus a hard premium for 1/1s where scarcity becomes
 * the whole story.
 */
export async function multiplierFor(meta: {
  parallel_name: string | null; print_run: number | null;
  grader: string | null; grade: number | null; section: string;
}): Promise<number> {
  let mult = 1;

  if (meta.parallel_name) {
    const declared = await one<{ fallback_mult: number | null }>(
      `SELECT fallback_mult FROM parallels WHERE name = $1 LIMIT 1`, [meta.parallel_name],
    );
    if (declared?.fallback_mult) {
      mult = Number(declared.fallback_mult);
    } else {
      const run = meta.print_run ?? printRunFromParallelName(meta.parallel_name);
      if (run === 1) mult = 25;
      else if (run != null) {
        // /299 -> ~1.6x, /99 -> ~2.6x, /25 -> ~5x, /10 -> ~8x
        mult = Math.max(1.2, Math.min(20, 26 / Math.pow(run, 0.52)));
      } else {
        // unnumbered colour parallel
        mult = 1.6;
      }
    }
  }

  if (meta.grader && meta.grade != null) {
    // Grade multipliers on top of raw. These are conservative for modern
    // full-bleed inserts where centering caps a lot of cards at 9.
    const g = Number(meta.grade);
    const gradeMult =
      g >= 10 ? (meta.grader === 'BGS' ? 4.2 : 3.4)
      : g >= 9.5 ? 2.2
      : g >= 9 ? 1.45
      : g >= 8 ? 1.05
      : 0.8;
    mult *= gradeMult;
  }

  return Math.round(mult * 1000) / 1000;
}

/** Persist a valuation row. Idempotent per (sku, marketplace, day, window). */
export async function saveValuation(v: ValuationOut, windowDays = WINDOW_DAYS): Promise<void> {
  await q(
    `INSERT INTO valuations
       (sku_id, marketplace_code, as_of, window_days, n_comps, median_aud, trimmed_mean_aud,
        p25_aud, p75_aud, low_aud, high_aud, fair_value_aud, trend_30d_pct, trend_90d_pct,
        volatility, method, confidence)
     VALUES ($1,$2,date_trunc('hour', now()),$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (sku_id, marketplace_code, as_of, window_days) DO UPDATE SET
       n_comps = EXCLUDED.n_comps, median_aud = EXCLUDED.median_aud,
       fair_value_aud = EXCLUDED.fair_value_aud, low_aud = EXCLUDED.low_aud,
       high_aud = EXCLUDED.high_aud, p25_aud = EXCLUDED.p25_aud, p75_aud = EXCLUDED.p75_aud,
       trend_30d_pct = EXCLUDED.trend_30d_pct, trend_90d_pct = EXCLUDED.trend_90d_pct,
       volatility = EXCLUDED.volatility, method = EXCLUDED.method, confidence = EXCLUDED.confidence`,
    [v.skuId, v.marketplaceCode, windowDays, v.nComps, v.medianAud, v.p25Aud, v.p75Aud,
     v.lowAud, v.highAud, v.fairValueAud, v.trend30dPct, v.trend90dPct, v.volatility,
     v.method, v.confidence],
  );
}

/**
 * Revalue every SKU that has new comps, plus everything you hold.
 * Per-marketplace valuations are computed only where there's real data;
 * the global blend is always computed so the UI has a number.
 */
export async function revalueAll(opts: { onlyHeld?: boolean; limit?: number } = {}): Promise<number> {
  const rows = await q<{ sku_id: number }>(
    opts.onlyHeld
      ? `SELECT h.sku_id FROM holdings h WHERE h.qty > 0`
      : `SELECT DISTINCT s.id AS sku_id FROM skus s
           LEFT JOIN holdings h ON h.sku_id = s.id
          WHERE h.sku_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM comps c WHERE c.sku_id = s.id AND NOT c.excluded)
          LIMIT $1`,
    opts.onlyHeld ? [] : [opts.limit ?? 20000],
  );

  const perMarket = await q<{ code: string }>(
    `SELECT code FROM marketplaces WHERE active AND code IN
       (SELECT DISTINCT marketplace_code FROM comps WHERE NOT excluded AND is_sold)`,
  );

  let n = 0;
  for (const { sku_id } of rows) {
    const global = await valueSku({ skuId: sku_id, marketplaceCode: null });
    if (global) { await saveValuation(global); n++; }

    for (const { code } of perMarket) {
      const local = await valueSku({ skuId: sku_id, marketplaceCode: code });
      // only store a per-market row when it's backed by that market's own sales
      if (local && local.method === 'comps' && local.nComps >= 2) await saveValuation(local);
    }
  }
  log.info({ skus: rows.length, valuations: n }, 'revalue complete');
  return n;
}

/** Sales velocity from comps + active listing counts. */
export async function computeVelocity(skuId: number, marketplaceCode: string | null, windowDays = 30) {
  const row = await one<{ sales: number; active: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM comps c
         WHERE c.sku_id = $1 AND NOT c.excluded AND c.is_sold
           AND c.sold_at >= now() - ($3 || ' days')::interval
           AND ($2::text IS NULL OR c.marketplace_code = $2)) AS sales,
       (SELECT COUNT(*)::int FROM comps c
          JOIN listings l ON l.id = c.listing_id
         WHERE c.sku_id = $1 AND NOT c.is_sold
           AND l.observed_at >= now() - interval '14 days'
           AND ($2::text IS NULL OR c.marketplace_code = $2)) AS active`,
    [skuId, marketplaceCode, String(windowDays)],
  );
  const sales = row?.sales ?? 0;
  const active = row?.active ?? 0;
  const perDay = sales / windowDays;
  const sellThrough = sales + active > 0 ? sales / (sales + active) : null;
  const daysToSell = perDay > 0 ? Math.round((1 / perDay) * 10) / 10 : null;

  await q(
    `INSERT INTO velocity (sku_id, marketplace_code, as_of, window_days, sales_count,
                           active_listings, sell_through, sales_per_day, days_to_sell_est)
     VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (sku_id, marketplace_code, as_of, window_days) DO UPDATE SET
       sales_count = EXCLUDED.sales_count, active_listings = EXCLUDED.active_listings,
       sell_through = EXCLUDED.sell_through, sales_per_day = EXCLUDED.sales_per_day,
       days_to_sell_est = EXCLUDED.days_to_sell_est`,
    [skuId, marketplaceCode, windowDays, sales, active, sellThrough, perDay, daysToSell],
  );

  return { sales, active, sellThrough, salesPerDay: perDay, daysToSell };
}

export { WC_FINAL };
