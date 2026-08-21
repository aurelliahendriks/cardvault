/** Run the recommender in-process for the owned SKUs — no queue, no worker. */
import { q } from '../src/db.js';
import { recommendSku } from '../src/recommend/engine.js';

const rows = await q<{ sku_id: number }>(
  `SELECT DISTINCT s.id AS sku_id FROM skus s JOIN holdings h ON h.sku_id = s.id
    WHERE h.qty > 0 LIMIT ${Number(process.argv[2] ?? 20)}`);
let ok = 0;
for (const r of rows) {
  const rec = await recommendSku(r.sku_id, { useAi: false });
  if (rec) { ok++; process.stdout.write(`  ${rec.label.slice(0, 46).padEnd(48)} ${rec.action}\n`); }
}
console.log(`${ok}/${rows.length} recommended`);
process.exit(0);
