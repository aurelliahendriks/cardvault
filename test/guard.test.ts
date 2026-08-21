import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardSql } from '../src/ai/nlQuery.ts';

test('accepts a plain SELECT and adds a limit', () => {
  const r = guardSql('SELECT player, total_value_aud FROM my_portfolio ORDER BY total_value_aud DESC');
  assert.equal(r.ok, true);
  assert.match(r.sql!, /LIMIT 200$/);
});

test('accepts a CTE and allows its own name as a relation', () => {
  const r = guardSql(`WITH top AS (SELECT sku_id, total_value_aud FROM my_portfolio LIMIT 10)
                      SELECT * FROM top`);
  assert.equal(r.ok, true, r.reason);
});

test('clamps an oversized limit instead of rejecting', () => {
  const r = guardSql('SELECT * FROM my_portfolio LIMIT 100000');
  assert.equal(r.ok, true);
  assert.match(r.sql!, /LIMIT 200/);
});

test('rejects every write verb', () => {
  for (const sql of [
    'DELETE FROM holdings',
    'UPDATE holdings SET qty = 0',
    'INSERT INTO holdings (sku_id, qty) VALUES (1,1)',
    'DROP TABLE cards',
    'TRUNCATE comps',
    'GRANT ALL ON cards TO public',
  ]) {
    assert.equal(guardSql(sql).ok, false, `should have rejected: ${sql}`);
  }
});

test('rejects stacked statements and comment smuggling', () => {
  assert.equal(guardSql('SELECT 1; DROP TABLE cards').ok, false);
  assert.equal(guardSql('SELECT * FROM my_portfolio -- DROP TABLE cards').ok, false);
  assert.equal(guardSql('SELECT * FROM my_portfolio /* sneaky */').ok, false);
});

test('rejects a write hidden inside a CTE', () => {
  const r = guardSql(`WITH x AS (DELETE FROM holdings RETURNING *) SELECT * FROM x`);
  assert.equal(r.ok, false);
});

test('rejects system catalogs and dangerous functions', () => {
  assert.equal(guardSql('SELECT * FROM pg_catalog.pg_user').ok, false);
  assert.equal(guardSql('SELECT * FROM information_schema.tables').ok, false);
  assert.equal(guardSql('SELECT pg_sleep(30)').ok, false);
  assert.equal(guardSql('SELECT pg_read_file(\'/etc/passwd\')').ok, false);
});

test('rejects relations that are not on the whitelist', () => {
  const r = guardSql('SELECT * FROM _migrations');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /_migrations/);
});

test('rejects anything that does not start with SELECT or WITH', () => {
  assert.equal(guardSql('EXPLAIN SELECT * FROM cards').ok, false);
  assert.equal(guardSql('').ok, false);
});

test('allows joins across whitelisted relations', () => {
  const r = guardSql(`SELECT d.player, v.fair_value_aud
                        FROM sku_detail d
                        JOIN latest_valuation v ON v.sku_id = d.sku_id
                        LEFT JOIN my_holdings h ON h.sku_id = d.sku_id
                       WHERE v.n_comps > 0 LIMIT 50`);
  assert.equal(r.ok, true, r.reason);
});

test('the unscoped owned tables are not readable at all', () => {
  // This is the tenancy boundary, and it lives in the whitelist rather than in the prompt.
  // `portfolio`, `holdings`, `sales` and `watchlist` span every account: a generated
  // `SELECT SUM(total_value_aud) FROM portfolio` is well-formed SQL that reads everybody's
  // collection including cost basis, and no amount of instruction reliably stops a model
  // writing it. The `my_*` views filter on a session GUC the model cannot set, so scope is a
  // property of which rows exist rather than of what the query says.
  for (const relation of ['portfolio', 'holdings', 'sales', 'watchlist']) {
    const r = guardSql(`SELECT * FROM ${relation} LIMIT 5`);
    assert.equal(r.ok, false, `${relation} must not be readable by generated SQL`);
    assert.match(r.reason ?? '', /relation/i);
  }
});

test('a query that reaches for another account still cannot name the table', () => {
  const r = guardSql(`SELECT owner_name, SUM(total_value_aud) FROM portfolio GROUP BY 1`);
  assert.equal(r.ok, false, 'cross-account aggregate must be refused at the whitelist');
});
