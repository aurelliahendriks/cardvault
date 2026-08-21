import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, one } from '../db.js';
import { log } from '../logger.js';
import { productShortSql } from '../products.js';
import { printRunFromParallelName } from '../match/titleParse.js';

/**
 * Load the checklist extracted from the original HTML tracker.
 *
 * The seeded `est` values are carried across deliberately: they are a real
 * hand-built prior, and they are what the app falls back to (as method='seed',
 * confidence 0.12) until live comps replace them. Nothing is lost by migrating.
 */

const here = dirname(fileURLToPath(import.meta.url));
const seedDir = join(here, '..', '..', 'db', 'seeds');

interface SeedCard {
  id: string; p: string; sec: string; num: string;
  player: string; team: string; sub: string; est: number; hot: number;
  /**
   * The club, for products whose checklist names a club rather than a country.
   *
   * `team` is the NATION everywhere else in this app — it picks the nation-kit avatar, fills
   * the nation filter, and drives the regional demand priors. Writing "FC Barcelona" into it
   * would put Barcelona in the list of countries and a fabricated flag behind the player, so
   * club-format products (Prizm, Topps Chrome UCC) leave `team` empty and set this instead.
   * It reaches search_text and notes, which is what makes "barcelona" find the card without
   * claiming it is a nationality.
   */
  club?: string;
}

/**
 * Full product names, for the text the matcher searches. Longer than the display short names
 * on purpose: a listing title says "2025-26 Panini Prizm FIFA", so those words need to be in
 * search_text to score.
 */
const PRODUCT_SEARCH_NAME: Record<string, string> = {
  A: 'Donruss Road to World Cup 2025-26',
  B: 'Panini FIFA World Cup 2026',
  C: 'Panini Prizm FIFA 2025-26',
  D: 'Panini Select Road to FIFA World Cup 2026',
  E: 'Topps Chrome UEFA Club Competitions 2025-26',
};

const cards: SeedCard[] = JSON.parse(await readFile(join(seedDir, 'cards.json'), 'utf8'));
const secpars: Record<string, string[]> = JSON.parse(await readFile(join(seedDir, 'parallels.json'), 'utf8'));

log.info({ cards: cards.length, parallelGroups: Object.keys(secpars).length }, 'seeding checklist');

// --- cards -----------------------------------------------------------------
let inserted = 0;
for (const c of cards) {
  const isAuto = /autograph|signature/i.test(c.sec);
  const isInsert = !/^base/i.test(c.sec);
  // The product name was a two-branch ternary, so every card outside A was described as
  // "Panini FIFA World Cup 2026" in the text the matcher searches — which would have made a
  // Prizm card findable by the wrong set name and not by its own.
  const searchText = [
    c.player, c.team, c.club, c.sec, c.num,
    PRODUCT_SEARCH_NAME[c.p] ?? '',
    c.sub === 'RR' ? 'Rated Rookie' : '',
  ].filter(Boolean).join(' ');

  await q(
    `INSERT INTO cards (legacy_id, product_code, section, card_number, player, team, subset,
                        is_rookie, is_auto, is_insert, seed_est_aud, hot, search_text, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (legacy_id) DO UPDATE SET
       seed_est_aud = EXCLUDED.seed_est_aud, hot = EXCLUDED.hot,
       search_text = EXCLUDED.search_text, team = EXCLUDED.team, notes = EXCLUDED.notes`,
    [c.id, c.p, c.sec, c.num, c.player, c.team || null, c.sub ?? '',
     c.sub === 'RR', isAuto, isInsert, c.est, c.hot === 1, searchText,
     c.club ? `Club: ${c.club}` : null],
  );
  inserted++;
}
log.info({ inserted }, 'cards seeded');

// --- parallels -------------------------------------------------------------
// The HTML tracker stored these as "PRODUCT|Section" -> [names]. Print runs are
// embedded in the names ("Gold (#/10)"), so pull them out into a real column —
// that's what makes the print-run-aware multiplier and matching work.
let parCount = 0;
for (const [key, names] of Object.entries(secpars)) {
  const [product, section] = key.split('|');
  if (!product || !section) continue;
  for (const name of names) {
    const run = printRunFromParallelName(name);
    const aliases = buildAliases(name);
    await q(
      `INSERT INTO parallels (product_code, section, name, print_run, aliases)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_code, section, name) DO UPDATE SET
         print_run = COALESCE(EXCLUDED.print_run, parallels.print_run),
         aliases = EXCLUDED.aliases`,
      [product, section, name, run, aliases],
    );
    parCount++;
  }
}
// Report the row count, not the attempt count: parallels.json lists a few names under
// more than one section, so "164 seeded" was four higher than the table ever held.
const parRows = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM parallels`);
log.info({ attempted: parCount, parallels: parRows?.n ?? 0 }, 'parallels seeded');

// --- base SKUs -------------------------------------------------------------
// One raw/base SKU per card so there's always something to attach a price to.
const made = await one<{ n: number }>(
  `WITH ins AS (
     INSERT INTO skus (card_id, parallel_id, grader, grade, label)
     SELECT c.id, NULL, NULL, NULL,
            (${productShortSql()})
            || ' · ' || c.section || ' · #' || c.card_number || ' · ' || c.player || ' · Raw'
       FROM cards c
      WHERE NOT EXISTS (
        SELECT 1 FROM skus s WHERE s.card_id = c.id
          AND s.parallel_id IS NULL AND s.grader IS NULL AND s.grade IS NULL)
     RETURNING 1
   ) SELECT COUNT(*)::int AS n FROM ins`,
);
log.info({ baseSkus: made?.n ?? 0 }, 'base SKUs created');

// --- players ---------------------------------------------------------------
// This has to happen here rather than in a migration. `players` is derived from the
// checklist, and on a fresh install the migrations run *before* the checklist is seeded —
// so the version that lived in migration 006 inserted nothing, and a brand-new install
// came up with an empty player-first view. Found by installing from scratch, which is the
// one test path that is easy to never actually run.
const players = await one<{ n: number }>(
  `WITH ins AS (
     INSERT INTO players (name, normalized)
     SELECT DISTINCT c.player, lower(unaccent(c.player))
       FROM cards c
      WHERE c.player <> ''
        AND NOT EXISTS (SELECT 1 FROM players p WHERE p.name = c.player)
     RETURNING 1
   ) SELECT COUNT(*)::int AS n FROM ins`,
);
log.info({ players: players?.n ?? 0 }, 'players derived from the checklist');

// Positions and clubs are name-matched, so they run last. Both are idempotent and both
// only fill blanks — a value you set by hand is never overwritten.
for (const file of ['positions.sql', 'clubs.sql']) {
  try {
    await q(await readFile(join(seedDir, file), 'utf8'));
    const col = file.startsWith('pos') ? 'position' : 'club';
    const n = await one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM players WHERE ${col} IS NOT NULL`);
    log.info({ [col]: n?.n ?? 0 }, `${col} seed applied`);
  } catch (e: any) {
    log.warn({ file, err: e.message }, 'optional seed skipped');
  }
}

/** Title-matching synonyms so "Silver Holo" also matches a listing saying "holo silver". */
function buildAliases(name: string): string[] {
  const clean = name.replace(/\(.*?\)/g, '').replace(/#?\/\s*\d+/g, '').trim().toLowerCase();
  const out = new Set<string>([clean]);
  const words = clean.split(/\s+and\s+|\s+/).filter((w) => w.length > 2 && w !== 'and');
  if (words.length > 1) {
    out.add(words.join(' '));
    out.add([...words].reverse().join(' '));
  }
  for (const w of words) out.add(w);
  return [...out].filter(Boolean).slice(0, 12);
}

await pool.end();
log.info('seed complete');
