import { pool } from '../db.js';
import { recommendPortfolio, recommendSku } from '../recommend/engine.js';

const args = process.argv.slice(2);
const noAi = args.includes('--no-ai');
const skuArg = args.find((a) => /^\d+$/.test(a));

if (skuArg) {
  const r = await recommendSku(Number(skuArg), { useAi: !noAi });
  if (!r) console.log('no valuation for that SKU — run revalue first');
  else {
    console.log(`\n${'='.repeat(78)}\n${r.label}\n${'='.repeat(78)}`);
    console.log(r.reasoning);
    console.log(`\nVenue ladder (net AUD):`);
    for (const v of r.venueLadder.slice(0, 6)) {
      console.log(`  ${v.netAud.toFixed(2).padStart(10)}  ${v.name.padEnd(30)} keep ${(v.keepRate * 100).toFixed(0)}%${v.requiresLocalEntity ? '  [needs local entity]' : ''}${v.belowBreakEven ? '  [below break-even]' : ''}`);
    }
    console.log(`\nCommunities:`);
    for (const c of r.communities) {
      console.log(`  ${c.expectedNetAud.toFixed(2).padStart(10)}  ${c.name.padEnd(34)} fit ${(c.fitScore * 100).toFixed(0)}%`);
    }
  }
} else {
  const recs = await recommendPortfolio({ useAi: !noAi });
  console.log(`\n${recs.length} recommendations, highest stakes first:\n`);
  for (const r of recs.slice(0, 30)) {
    console.log(`[${r.action.toUpperCase().padEnd(15)}] A$${r.valueAud.toFixed(2).padStart(9)}  ${r.label}`);
    console.log(`   -> ${r.bestVenue?.name ?? '?'} net A$${(r.bestVenue?.netAud ?? 0).toFixed(2)}  |  ${r.communities[0]?.name ?? '?'}  |  90d decay A$${r.timing.cost90Aud.toFixed(2)}`);
  }
}

await pool.end();
