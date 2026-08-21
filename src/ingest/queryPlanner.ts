import { q } from '../db.js';

export interface CardRow {
  card_id: number;
  legacy_id: string;
  product_code: string;
  product_name: string;
  section: string;
  card_number: string;
  player: string;
  team: string | null;
  subset: string;
  hot: boolean;
  seed_est_aud: number | null;
}

/**
 * Search strings are the single biggest lever on comp quality. Too specific and
 * you get zero results on a thin market; too loose and you drown in the wrong
 * player's cards. We emit a short ladder from tight to loose and let the runner
 * stop as soon as one rung returns enough matched comps.
 */
export function buildQueries(c: CardRow): string[] {
  const year = c.product_code === 'A' ? '2025-26' : '2026';
  const brand = c.product_code === 'A' ? 'Donruss' : 'Panini';
  const setWord = c.product_code === 'A' ? 'Road to World Cup' : 'World Cup';
  const isBase = /^base/i.test(c.section);
  const rr = c.subset === 'RR' ? 'Rated Rookie' : '';
  const player = c.player;
  const num = `#${c.card_number}`;

  const ladder: string[] = [];

  // 1. Tight: brand + set + player + number. Best precision.
  ladder.push([year, brand, setWord, player, num, isBase ? '' : c.section, rr].filter(Boolean).join(' '));

  // 2. Drop the year (sellers often omit it, or use the other half of 25/26).
  ladder.push([brand, setWord, player, num, isBase ? '' : c.section].filter(Boolean).join(' '));

  // 3. Player + number + section. Catches sellers who skip the brand entirely.
  ladder.push([player, num, isBase ? setWord : c.section].filter(Boolean).join(' '));

  // 4. Loosest: player + set. Only used when the tighter rungs came back empty;
  //    the matcher's card-number check does the filtering instead.
  ladder.push([player, setWord, brand].filter(Boolean).join(' '));

  return [...new Set(ladder.map((s) => s.replace(/\s+/g, ' ').trim()))];
}

/** A parallel-specific query — worth a separate call for numbered parallels of stars. */
export function buildParallelQuery(c: CardRow, parallelName: string): string {
  const brand = c.product_code === 'A' ? 'Donruss' : 'Panini';
  // strip the print run out of the display name: "Gold (#/10)" -> "Gold"
  const clean = parallelName.replace(/\(.*?\)/g, '').replace(/#?\/\s*\d+/g, '').trim();
  return [brand, c.player, `#${c.card_number}`, clean].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

/**
 * What to poll this cycle, in priority order.
 *
 * Priority is deliberately not "most valuable first" — it is "where fresh data
 * changes a decision". A card you own with stale comps outranks a A$5000 Kaboom
 * you don't own and priced yesterday.
 */
export async function selectTargets(opts: {
  mode: 'hot' | 'full' | 'held' | 'card';
  minValueAud?: number;
  limit?: number;
  cardIds?: number[];
}): Promise<CardRow[]> {
  const limit = opts.limit ?? 200;

  if (opts.mode === 'card' && opts.cardIds?.length) {
    return q<CardRow>(
      `SELECT c.id AS card_id, c.legacy_id, c.product_code, p.name AS product_name, c.section,
              c.card_number, c.player, c.team, c.subset, c.hot, c.seed_est_aud
         FROM cards c JOIN products p ON p.code = c.product_code
        WHERE c.id = ANY($1::bigint[])`,
      [opts.cardIds],
    );
  }

  const minVal = opts.minValueAud ?? 0;

  // staleness in hours, and whether we hold it
  const base = `
    WITH held AS (
      SELECT DISTINCT s.card_id FROM holdings h JOIN skus s ON s.id = h.sku_id WHERE h.qty > 0
    ),
    freshness AS (
      SELECT s.card_id, MAX(v.as_of) AS last_priced
        FROM valuations v JOIN skus s ON s.id = v.sku_id
       GROUP BY s.card_id
    )
    SELECT c.id AS card_id, c.legacy_id, c.product_code, p.name AS product_name, c.section,
           c.card_number, c.player, c.team, c.subset, c.hot, c.seed_est_aud,
           (h.card_id IS NOT NULL) AS is_held,
           COALESCE(EXTRACT(EPOCH FROM (now() - f.last_priced)) / 3600, 99999) AS stale_hours
      FROM cards c
      JOIN products p ON p.code = c.product_code
      LEFT JOIN held h ON h.card_id = c.id
      LEFT JOIN freshness f ON f.card_id = c.id`;

  if (opts.mode === 'held') {
    return q<CardRow>(`${base} WHERE h.card_id IS NOT NULL ORDER BY stale_hours DESC LIMIT $1`, [limit]);
  }

  if (opts.mode === 'hot') {
    // Anything you hold, anything flagged hot, anything expensive — freshest-last.
    return q<CardRow>(
      `${base}
        WHERE (h.card_id IS NOT NULL OR c.hot OR COALESCE(c.seed_est_aud,0) >= $2)
          AND COALESCE(EXTRACT(EPOCH FROM (now() - f.last_priced)) / 3600, 99999) > 6
        ORDER BY (h.card_id IS NOT NULL) DESC, c.hot DESC, stale_hours DESC,
                 COALESCE(c.seed_est_aud,0) DESC
        LIMIT $1`,
      [limit, Math.max(minVal, 25)],
    );
  }

  // full sweep: everything above the value floor, oldest data first
  return q<CardRow>(
    `${base}
      WHERE (h.card_id IS NOT NULL OR c.hot OR COALESCE(c.seed_est_aud,0) >= $2)
      ORDER BY stale_hours DESC, COALESCE(c.seed_est_aud,0) DESC
      LIMIT $1`,
    [limit, minVal],
  );
}
