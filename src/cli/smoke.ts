/**
 * End-to-end smoke test with synthetic listings.
 *
 * Runs the whole pipeline with no external API calls: fabricate realistic
 * eBay-style titles and prices, push them through the real matcher, valuation
 * engine and recommendation engine, and print what comes out. This is what to
 * run after any change to matching or pricing logic.
 *
 *   npm run smoke
 */
import { pool, q, one } from '../db.js';
import { matchListings } from '../ingest/run.js';
import { log } from '../logger.js';
import { baseSkuFor, resolveListing } from '../match/resolve.js';
import { recommendSku } from '../recommend/engine.js';
import { revalueAll } from '../valuation/engine.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

// Realistic messy titles, including the ones that SHOULD be rejected.
const SYNTHETIC: Array<[string, number, string, string, number]> = [
  // [title, price, currency, marketplace, daysAgo]
  ['2026 Panini FIFA World Cup Gilberto Mora #214 Rated Rookie Mexico RC', 41.0, 'AUD', 'EBAY_AU', 3],
  ['Panini World Cup 2026 Gilberto Mora 214 Rated Rookie', 38.5, 'AUD', 'EBAY_AU', 8],
  ['Gilberto Mora #214 Rated Rookie Panini World Cup Mexico', 44.0, 'AUD', 'EBAY_AU', 14],
  ['2026 Panini World Cup #214 Gilberto Mora RR Mexico Rookie', 36.0, 'AUD', 'EBAY_AU', 22],
  ['Gilberto Mora Rated Rookie #214 World Cup 2026 Panini', 29.99, 'USD', 'EBAY_US', 5],
  ['Gilberto Mora #214 RR Panini World Cup 2026 Mexico', 27.5, 'USD', 'EBAY_US', 11],
  // an obvious mismatch that outlier rejection should neutralise
  ['Gilberto Mora #214 Rated Rookie World Cup 2026 Panini MINT', 1200.0, 'AUD', 'EBAY_AU', 6],
  // things that must be rejected outright
  ['Lot of 30 Panini World Cup 2026 base cards inc Mora', 55.0, 'AUD', 'EBAY_AU', 4],
  ['Panini World Cup 2026 PYT break random team Mexico', 12.0, 'AUD', 'EBAY_AU', 2],
  ['Gilberto Mora REPRINT custom art card World Cup', 9.99, 'AUD', 'EBAY_AU', 7],
  ['Panini World Cup 2026 sticker album complete Mexico', 45.0, 'AUD', 'EBAY_AU', 9],

  // a Kaboom, graded and raw, plus a parallel
  ['2026 Panini World Cup Lionel Messi Kaboom! Argentina', 6800.0, 'AUD', 'EBAY_AU', 12],
  ['Lionel Messi Kaboom Panini World Cup 2026 PSA 10 GEM MT', 24000.0, 'AUD', 'EBAY_AU', 20],
  ['Messi Kaboom! World Cup 2026 Panini Argentina', 4900.0, 'USD', 'EBAY_US', 6],
  ['Lionel Messi Kaboom Panini World Cup 2026', 7100.0, 'AUD', 'EBAY_AU', 30],

  // Donruss base with a numbered parallel
  ['2025-26 Donruss Road to World Cup Lamine Yamal #10 Spain', 2.9, 'AUD', 'EBAY_AU', 2],
  ['Donruss Road to World Cup Lamine Yamal 10 Spain Base', 2.6, 'AUD', 'EBAY_AU', 5],
  ['Donruss Road to WC Lamine Yamal #10 Base Spain', 3.1, 'AUD', 'EBAY_AU', 9],
  ['Lamine Yamal #10 Donruss Road to World Cup 25/26', 2.75, 'AUD', 'EBAY_AU', 15],
  ['Donruss Road to World Cup Lamine Yamal #10 Blue #/49 Spain', 78.0, 'AUD', 'EBAY_AU', 7],
  ['Lamine Yamal Blue 23/49 Donruss Road to World Cup #10', 84.0, 'AUD', 'EBAY_AU', 18],
  ['Yamal #10 Donruss RTWC Gold /10 Spain', 340.0, 'AUD', 'EBAY_AU', 10],
];

log.info('--- clearing previous smoke data ---');
await q(`DELETE FROM listings WHERE source_code = 'csv_import' AND external_id LIKE 'smoke:%'`);

log.info('--- inserting synthetic listings ---');
const ids: number[] = [];
for (const [i, [title, price, currency, market, days]] of SYNTHETIC.entries()) {
  const row = await one<{ id: number }>(
    `INSERT INTO listings (source_code, marketplace_code, external_id, title, price, currency,
                           shipping, is_sold, sold_at, format)
     VALUES ('csv_import',$1,$2,$3,$4,$5,0,TRUE,$6,'fixed')
     ON CONFLICT (source_code, marketplace_code, external_id) DO UPDATE SET price = EXCLUDED.price
     RETURNING id`,
    [market, `smoke:${i}`, title, price, currency, daysAgo(days)],
  );
  if (row) ids.push(row.id);
}
log.info({ n: ids.length }, 'listings inserted');

log.info('--- matching (no AI: deterministic tiers only) ---');
const m = await matchListings(ids, { allowLlm: false });
log.info(m, 'match result');

// show what the matcher decided, so a regression is visible not silent
const decisions = await q<{ title: string; label: string | null; method: string; conf: number; excluded: boolean; reason: string | null }>(
  `SELECT l.title, d.label, c.match_method AS method, c.match_confidence AS conf,
          c.excluded, c.exclude_reason AS reason
     FROM comps c JOIN listings l ON l.id = c.listing_id
     LEFT JOIN sku_detail d ON d.sku_id = c.sku_id
    WHERE l.external_id LIKE 'smoke:%' ORDER BY l.external_id`,
);
console.log('\n=== MATCH DECISIONS ===');
for (const d of decisions) {
  const mark = d.excluded ? `REJECT(${d.reason})` : 'OK';
  console.log(`${mark.padEnd(22)} ${String(d.method).padEnd(10)} ${(Number(d.conf) * 100).toFixed(0).padStart(3)}%  ${d.title.slice(0, 62)}`);
  if (!d.excluded) console.log(`${' '.repeat(39)}-> ${d.label}`);
}

log.info('--- valuing ---');
await revalueAll({});

const priced = await q<any>(
  `SELECT d.label, v.n_comps, v.fair_value_aud, v.median_aud, v.low_aud, v.high_aud,
          v.trend_30d_pct, v.volatility, v.method, v.confidence
     FROM latest_valuation v JOIN sku_detail d ON d.sku_id = v.sku_id
    WHERE v.marketplace_code IS NULL AND v.n_comps > 0
    ORDER BY v.fair_value_aud DESC`,
);
console.log('\n=== VALUATIONS (comp-backed only) ===');
for (const p of priced) {
  console.log(
    `A$${Number(p.fair_value_aud).toFixed(2).padStart(10)}  n=${String(p.n_comps).padStart(2)}  ` +
    `range ${Number(p.low_aud).toFixed(0)}-${Number(p.high_aud).toFixed(0)}  ` +
    `vol ${Number(p.volatility).toFixed(2)}  conf ${(Number(p.confidence) * 100).toFixed(0)}%  ${p.label}`,
  );
}

log.info('--- creating holdings so recommendations have something to work on ---');
for (const legacy of ['A|Base|214', 'A|Kaboom!|1', 'A|Base|10']) {
  const c = await one<{ id: number }>(`SELECT id FROM cards WHERE legacy_id = $1`, [legacy]);
  if (!c) { log.warn({ legacy }, 'card not found — checklist may differ'); continue; }
  const sku = await baseSkuFor(c.id);
  await q(`INSERT INTO holdings (sku_id, qty, cost_basis_aud) VALUES ($1,$2,$3)
             ON CONFLICT (sku_id) DO UPDATE SET qty = EXCLUDED.qty`, [sku, 4, 5]);
}
// also hold the graded Messi and the numbered Yamal if the matcher created them
const extras = await q<{ id: number }>(
  `SELECT s.id FROM skus s WHERE s.grader IS NOT NULL OR s.parallel_id IS NOT NULL`,
);
for (const e of extras) {
  await q(`INSERT INTO holdings (sku_id, qty) VALUES ($1,1) ON CONFLICT (sku_id) DO NOTHING`, [e.id]);
}

log.info('--- recommending (no AI polish) ---');
const held = await q<{ sku_id: number }>(`SELECT sku_id FROM holdings WHERE qty > 0`);
console.log('\n=== RECOMMENDATIONS ===');
for (const h of held) {
  const r = await recommendSku(h.sku_id, { useAi: false });
  if (!r) continue;
  console.log(`\n${'-'.repeat(90)}\n${r.label}\n  ACTION: ${r.action}   value A$${r.valueAud.toFixed(2)}   urgency ${r.urgency}   stakes ${r.score.toFixed(0)}`);
  console.log(`  ${r.reasoning.split('\n').join('\n  ')}`);
  console.log(`  Venue ladder:`);
  for (const v of r.venueLadder.slice(0, 5)) {
    console.log(`    A$${v.netAud.toFixed(2).padStart(10)}  ${v.name.padEnd(28)} keep ${(v.keepRate * 100).toFixed(0)}%  ${v.grossBasis}${v.requiresLocalEntity ? ' [local entity]' : ''}${v.belowBreakEven ? ' [BELOW BREAK-EVEN]' : ''}`);
  }
  console.log(`  Communities: ${r.communities.map((c) => `${c.name} (A$${c.expectedNetAud.toFixed(2)}, fit ${(c.fitScore * 100).toFixed(0)}%)`).join('; ')}`);
}

console.log('\n=== SUMMARY ===');
const summary = await one<any>(
  `SELECT (SELECT COUNT(*)::int FROM cards) AS cards,
          (SELECT COUNT(*)::int FROM skus) AS skus,
          (SELECT COUNT(*)::int FROM parallels) AS parallels,
          (SELECT COUNT(*)::int FROM comps WHERE NOT excluded) AS comps_used,
          (SELECT COUNT(*)::int FROM comps WHERE excluded) AS comps_rejected,
          (SELECT COUNT(*)::int FROM valuations) AS valuations,
          (SELECT COUNT(*)::int FROM recommendations) AS recommendations,
          (SELECT COALESCE(SUM(total_value_aud),0) FROM portfolio) AS portfolio_aud`,
);
console.log(JSON.stringify(summary, null, 2));

await pool.end();
