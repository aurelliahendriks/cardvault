/**
 * Bundle db/migrations/*.sql into one file, and PROVE it can be run twice.
 *
 *   node tools/build-sql.mjs                       # build only
 *   DATABASE_URL=... node tools/build-sql.mjs --verify   # build, then apply it twice
 *
 * ---------------------------------------------------------------------------
 * WHY THE VERIFY STEP IS NOT OPTIONAL IN SPIRIT
 * ---------------------------------------------------------------------------
 *
 * The first version of this bundle claimed in its own header that running it twice was safe.
 * It was not: `ALTER TABLE skus DROP CONSTRAINT ...` had no IF EXISTS, so the second run
 * errored on line 139 and - because the whole bundle is one transaction - rolled back every
 * migration after it.
 *
 * What makes that worth a tool rather than a fix is how it hid. The obvious check is "run it
 * twice and diff the schema", and that check PASSED: the second run changed nothing because
 * it had rolled back, so the two schemas matched perfectly. A test that passes because the
 * work was undone is worse than no test.
 *
 * So `--verify` asserts three things, and the first is the one that matters:
 *
 *   1. every run exits zero and logs no ERROR       <- catches the rollback
 *   2. the schema after run 2 matches after run 1   <- catches genuine drift
 *   3. the schema is not empty                      <- catches "it built nothing"
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const MIGRATIONS = 'db/migrations';
const OUT = 'db/cardvault.sql';

const HEADER = `-- ===========================================================================
--  CardVault :: the whole database, in one file
-- ===========================================================================
--
--  Every migration in db/migrations/, in order, in one file. It exists because "run fifteen
--  files in the right sequence" is a worse instruction than "run this one".
--
--  ---------------------------------------------------------------------------
--  WHAT IT DOES NOT CONTAIN: THE CARDS
--  ---------------------------------------------------------------------------
--
--  The 2,521-card checklist lives in db/seeds/cards.json and loads separately, with
--  \`npm run seed\`. That split is deliberate:
--
--     this file    the SHAPE of the database - tables, views, constraints, and the parallel
--                  ladders for all five sets. Changes when the app changes.
--     cards.json   the CONTENTS - player names and card numbers off published checklists.
--                  Changes when a new set comes out.
--
--  So re-seeding the checklist cannot drop your collection, and changing the schema cannot
--  lose the checklist.
--
--  ---------------------------------------------------------------------------
--  RUNNING IT
--  ---------------------------------------------------------------------------
--
--     docker compose up migrate           <- the normal way: this file AND the seed
--
--  or by hand against a running database:
--
--     docker compose exec -T db psql -U cardvault -d cardvault < db/cardvault.sql
--     docker compose exec api npx tsx src/cli/seed.ts
--
--  ---------------------------------------------------------------------------
--  RUNNING IT TWICE IS SAFE, AND THAT IS TESTED
--  ---------------------------------------------------------------------------
--
--  Wrapped in one transaction, so a failure half way leaves nothing behind rather than a
--  half-built database that looks fine until something reads the missing half.
--
--  Every statement is IF NOT EXISTS, OR REPLACE, dropped-then-recreated, or ON CONFLICT DO
--  UPDATE. Verified by \`node tools/build-sql.mjs --verify\`, which applies the file twice and
--  checks that the SECOND run also succeeded - an earlier version of this bundle silently
--  rolled its second run back, and a naive schema diff called that a pass.
--
--  One honest limit of IF NOT EXISTS: it checks the NAME, not the shape. A table that already
--  exists with different columns is left alone, silently. That is fine for bringing a
--  database up to date, and it is why the tracked runner (src/cli/migrate.ts) stays the tool
--  for anything more interesting.
--
--  GENERATED FROM db/migrations/. Edit the migrations, not this file.
-- ===========================================================================

BEGIN;
`;

/**
 * The initial migration predates the IF NOT EXISTS habit — it was only ever meant to run once,
 * on an empty database, by a runner that tracks what it has applied. Every later migration
 * already guards itself, so only 001 is rewritten, and only in these four mechanical ways.
 */
function makeIdempotent(sql, name) {
  if (name !== '001_init.sql') return sql;
  let out = sql
    .replace(/^CREATE TABLE (?!IF NOT EXISTS)/gm, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/^CREATE INDEX (?!IF NOT EXISTS)/gm, 'CREATE INDEX IF NOT EXISTS ')
    .replace(/^CREATE UNIQUE INDEX (?!IF NOT EXISTS)/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
  // 001's views are redefined by later migrations, which drop them first. On a second run
  // they therefore already exist with a LATER shape, so CREATE OR REPLACE would fail on the
  // changed column list. Dropping is the only thing that works, and it is safe because
  // everything dropped is rebuilt further down the same file inside the same transaction.
  out = out.replace(/^CREATE VIEW (\w+) AS/gm,
    (_, v) => `DROP VIEW IF EXISTS ${v} CASCADE;\nCREATE VIEW ${v} AS`);
  return out;
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
let out = HEADER;
for (const name of files) {
  const body = makeIdempotent(readFileSync(join(MIGRATIONS, name), 'utf8').trimEnd(), name);
  out += `\n-- ###########################################################################\n`
       + `-- #  ${name}\n`
       + `-- ###########################################################################\n\n${body}\n`;
}
out += '\nCOMMIT;\n';
writeFileSync(OUT, out);
console.log(`${OUT}: ${files.length} migrations, ${out.split('\n').length} lines`);

// A cheap static net for the exact class of bug that got through last time.
const unguarded = out.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /^\s*ALTER TABLE .* DROP (CONSTRAINT|COLUMN) (?!IF EXISTS)/i.test(l));
if (unguarded.length) {
  console.error('\nDROP without IF EXISTS — these abort the whole bundle on a second run:');
  for (const [n, l] of unguarded) console.error(`  ${OUT}:${n}  ${l.trim()}`);
  process.exit(1);
}

if (!process.argv.includes('--verify')) process.exit(0);

// --- verify ---------------------------------------------------------------
const url = process.env.DATABASE_URL;
if (!url) { console.error('--verify needs DATABASE_URL (it creates a scratch database)'); process.exit(2); }
const admin = url.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const scratch = url.replace(/\/[^/?]+(\?|$)/, '/cv_bundle_check$1');
const psql = (conn, args) => execFileSync('psql', [conn, ...args], { encoding: 'utf8' });

psql(admin, ['-q', '-c', 'DROP DATABASE IF EXISTS cv_bundle_check']);
psql(admin, ['-q', '-c', 'CREATE DATABASE cv_bundle_check']);

const schemas = [];
for (const run of [1, 2]) {
  let log = '';
  let failed = false;
  try {
    log = psql(scratch, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', OUT]);
  } catch (e) {
    log = String(e.stdout ?? '') + String(e.stderr ?? '');
    failed = true;
  }
  const errors = log.split('\n').filter((l) => /ERROR:/.test(l));
  if (failed || errors.length) {
    console.error(`\nrun ${run} FAILED — this is the bug that hides behind a clean schema diff:`);
    for (const e of errors.slice(0, 5)) console.error('  ' + e.trim());
    process.exit(1);
  }
  console.log(`  run ${run}: applied cleanly`);
  schemas.push(execFileSync('pg_dump', ['-s', scratch], { encoding: 'utf8' })
    .split('\n').filter((l) => !/^\\(un)?restrict/.test(l)).join('\n'));
}

if (schemas[0] !== schemas[1]) {
  console.error('\nthe schema CHANGED between run 1 and run 2 — the bundle is not idempotent');
  process.exit(1);
}
const tables = (schemas[0].match(/^CREATE TABLE/gm) || []).length;
if (tables < 20) { console.error(`\nonly ${tables} tables were built — the bundle did nothing`); process.exit(1); }

psql(admin, ['-q', '-c', 'DROP DATABASE IF EXISTS cv_bundle_check']);
console.log(`  schema identical after both runs, ${tables} tables — bundle verified`);
