import { cfg } from '../config.js';
import { pool, q } from '../db.js';
import { log } from '../logger.js';

/**
 * Optional: embed card search text into pgvector for semantic matching.
 *
 * Trigram matching already handles typos and word order, which covers most real
 * listing titles. Embeddings help with the residual: nicknames, transliterated
 * names, and non-English titles ("Mbappé Francia dorada"). Skip this entirely
 * with EMBEDDING_PROVIDER=none — nothing else depends on it.
 */

const BATCH = 96;

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (cfg.EMBEDDING_PROVIDER === 'voyage') {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voyage-3', input: texts, output_dimension: 1536 }),
    });
    if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return j.data.map((d: any) => d.embedding);
  }
  if (cfg.EMBEDDING_PROVIDER === 'openai') {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts, dimensions: 1536 }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return j.data.map((d: any) => d.embedding);
  }
  throw new Error(`EMBEDDING_PROVIDER=${cfg.EMBEDDING_PROVIDER} — set it to 'voyage' or 'openai'`);
}

if (cfg.EMBEDDING_PROVIDER === 'none') {
  console.log('EMBEDDING_PROVIDER=none — nothing to do. Trigram matching is already active.');
  process.exit(0);
}

let done = 0;
for (;;) {
  const rows = await q<{ id: number; search_text: string }>(
    `SELECT id, search_text FROM cards WHERE embedding IS NULL AND search_text IS NOT NULL LIMIT $1`,
    [BATCH],
  );
  if (!rows.length) break;

  const vecs = await embedBatch(rows.map((r) => r.search_text));
  for (const [i, r] of rows.entries()) {
    const v = vecs[i];
    if (!v) continue;
    await q(`UPDATE cards SET embedding = $2::vector WHERE id = $1`, [r.id, `[${v.join(',')}]`]);
  }
  done += rows.length;
  log.info({ done }, 'embedded');
}

console.log(`embedded ${done} cards`);
await pool.end();
