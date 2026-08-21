import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q } from '../db.js';
import { log } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

await q(`CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now()
)`);

const applied = new Set((await q<{ name: string }>(`SELECT name FROM _migrations`)).map((r) => r.name));
const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

let n = 0;
for (const f of files) {
  if (applied.has(f)) continue;
  const sql = await readFile(join(migrationsDir, f), 'utf8');
  log.info({ migration: f }, 'applying');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [f]);
    await client.query('COMMIT');
    n++;
  } catch (e: any) {
    await client.query('ROLLBACK');
    log.error({ migration: f, err: e.message }, 'migration failed');
    process.exit(1);
  } finally {
    client.release();
  }
}

log.info({ applied: n, total: files.length }, n ? 'migrations applied' : 'schema already current');
await pool.end();
