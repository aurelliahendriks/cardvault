import pg from 'pg';
import { cfg } from './config.js';
import { log } from './logger.js';

// Keep NUMERIC as JS numbers. Card prices never approach float precision limits
// and the alternative (strings everywhere) poisons every downstream calculation.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v == null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v == null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: cfg.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (e) => log.error({ err: e }, 'idle pg client error'));

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const t0 = Date.now();
  try {
    const r = await pool.query(sql, params as any[]);
    const ms = Date.now() - t0;
    if (ms > 1500) log.warn({ ms, sql: sql.slice(0, 140) }, 'slow query');
    return r.rows as T[];
  } catch (e: any) {
    log.error({ err: e.message, sql: sql.slice(0, 400) }, 'query failed');
    throw e;
  }
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Read-only query on a short statement timeout. Used for AI-generated SQL:
 * combined with a SELECT-only guard and a dedicated role this is the boundary
 * between "the model writes queries" and "the model can hurt you".
 */
export async function readOnlyQuery<T = any>(
  sql: string,
  timeoutMs = 8000,
  opts: { userId?: number } = {},
): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    /**
     * Whose collection the generated SQL is allowed to see.
     *
     * The `my_holdings` / `my_sales` / `my_portfolio` views filter on this GUC, so scope is
     * enforced by the rows that exist rather than by anything the model wrote. There is no
     * SQL it can generate that widens it — "and also the other users" has no syntax when the
     * other users' rows are already gone.
     *
     * `SET LOCAL` inside the transaction, on a dedicated client, so a pooled connection
     * cannot carry one person's id into the next person's question. Unset means the views
     * return nothing, which is the correct direction to fail.
     */
    if (opts.userId != null) {
      await c.query(`SET LOCAL cardvault.user_id = '${Number(opts.userId)}'`);
    }
    const r = await c.query(sql);
    await c.query('ROLLBACK');
    return r.rows as T[];
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
