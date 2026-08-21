import { pool } from '../db.js';
import { runIngest } from '../ingest/run.js';
import { log } from '../logger.js';
import { refreshFx } from '../valuation/fx.js';

const [cmd = 'hot', ...rest] = process.argv.slice(2);

if (cmd === 'fx') {
  const n = await refreshFx();
  log.info({ pairs: n }, 'fx done');
} else if (['hot', 'full', 'held'].includes(cmd)) {
  const limit = rest[0] ? Number(rest[0]) : undefined;
  const r = await runIngest({ mode: cmd as any, limit });
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'card') {
  const ids = rest.map(Number).filter(Number.isFinite);
  if (!ids.length) {
    console.error('usage: npm run ingest -- card <cardId> [cardId...]');
    process.exit(1);
  }
  const r = await runIngest({ mode: 'card', cardIds: ids });
  console.log(JSON.stringify(r, null, 2));
} else {
  console.error(`usage:
  npm run ingest -- fx                     refresh FX rates
  npm run ingest -- hot [limit]            poll held + hot + valuable cards
  npm run ingest -- full [limit]           full sweep above the value floor
  npm run ingest -- held [limit]           only what you own
  npm run ingest -- card <cardId>...       specific cards`);
  process.exit(1);
}

await pool.end();
