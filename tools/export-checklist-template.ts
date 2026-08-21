/**
 * A fill-in-the-blanks CSV of the whole checklist.
 *
 * Clicking `+` on 100 tiles is the slowest possible way to enter a collection. This writes
 * every card as a row with an empty `qty`, so the actual job becomes: open it in Excel,
 * sort by player, type numbers next to the ones you own, delete the rest, paste back into
 * Data & sources. `legacy_id` is what matches on re-import, so it must survive the edit —
 * everything else is there to make the row readable while you work.
 *
 *   npx tsx tools/export-checklist-template.ts my-collection.csv          # everything
 *   npx tsx tools/export-checklist-template.ts hot.csv --hot              # the 92 hot cards
 *   npx tsx tools/export-checklist-template.ts messi.csv --player=Messi
 */
import { writeFileSync } from 'node:fs';
import { q } from '../src/db.js';

const out = process.argv[2] ?? 'collection-template.csv';
const args = process.argv.slice(3);
const player = args.find((a) => a.startsWith('--player='))?.split('=')[1];
const hotOnly = args.includes('--hot');

const where: string[] = ["c.player <> ''"];
const params: any[] = [];
if (player) { params.push(`%${player}%`); where.push(`c.player ILIKE $${params.length}`); }
if (hotOnly) where.push('c.hot');

const rows = await q<any>(
  `SELECT c.legacy_id, c.product_code, c.section, c.card_number, c.player, c.team,
          c.subset, c.hot, c.seed_est_aud,
          (SELECT COUNT(*)::int FROM parallels p
            WHERE p.product_code = c.product_code AND p.section = c.section) AS parallels
     FROM cards c
    WHERE ${where.join(' AND ')}
    ORDER BY c.player, c.product_code, c.section, c.card_number`, params);

const PRODUCT: Record<string, string> = { A: 'Donruss RTWC', B: 'Panini WC26', X: 'Custom' };
const esc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// qty first, and paid second, because those are the only two columns being typed into.
const header = ['qty', 'paid', 'notes', 'legacy_id', 'player', 'team', 'product', 'section',
                'card_number', 'rookie', 'hot', 'seed_est_aud', 'parallels_available'];

const lines = [header.join(',')];
for (const r of rows) {
  lines.push([
    '', '', '',
    r.legacy_id, r.player, r.team ?? '', PRODUCT[r.product_code] ?? r.product_code,
    r.section, r.card_number,
    r.subset === 'RR' ? 'RR' : '', r.hot ? 'hot' : '',
    r.seed_est_aud ?? '', r.parallels,
  ].map(esc).join(','));
}

writeFileSync(out, lines.join('\n') + '\n');
console.log(`${rows.length} rows -> ${out}`);
console.log('\nFill in qty (and paid, if you know it), delete every row you do not own,');
console.log('then paste the result into Data & sources -> Import your collection.');
console.log('Keep the legacy_id column: that is what matches the row back to a card.');
console.log('\nParallels and grades are not in here on purpose - a template with 164 parallel');
console.log('variants per card would be unusable. Import the base cards first, then set the');
console.log('version on the ones that are not raw base from the card detail panel.');
process.exit(0);
