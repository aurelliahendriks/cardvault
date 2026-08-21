import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cfg } from './config.js';
import { q, one } from './db.js';
import { log } from './logger.js';
import { printRunFromParallelName } from './match/titleParse.js';
import { productShort } from './products.js';

/**
 * Adding cards to your collection, including ones that aren't on the checklist.
 *
 * Two distinct jobs live here:
 *  - resolve a (card, parallel, grade) triple to a SKU, creating the parallel or
 *    the SKU if this is the first time you've owned that version
 *  - create an entirely new card when the checklist doesn't have it
 *
 * The second one matters more than it sounds. The checklist is 1,771 entries from
 * two products; the moment you own a Prizm, a sticker, or something from a set
 * that isn't in here, a tracker that can't represent it is a tracker you stop
 * using.
 */

export interface AddHoldingInput {
  /**
   * Whose collection. Required for anything that writes a holding.
   *
   * Not optional-with-a-default on purpose: a default owner is how one person's card silently
   * lands in another person's collection, and `UNIQUE (user_id, sku_id)` would then merge the
   * quantities. Callers that legitimately have no person — the CSV importer, the smoke test —
   * pass the owner explicitly.
   */
  userId?: number;
  // one of these identifies the card
  skuId?: number;
  cardId?: number;
  legacyId?: string;
  // version
  parallelName?: string | null;
  printRun?: number | null;
  grader?: string | null;
  grade?: number | null;
  // your copy
  qty?: number;
  costBasisAud?: number | null;
  acquiredAt?: string | null;
  boxId?: number | null;
  acquiredFrom?: string | null;
  condition?: string | null;
  priceOverrideAud?: number | null;
  notes?: string | null;
}

const GRADERS = new Set(['PSA', 'BGS', 'SGC', 'CGC', 'CSG', 'HGA', 'TAG', 'ACE', 'GMA']);

/**
 * Resolve the owning user, falling back to the owner account.
 *
 * The fallback exists for callers with no request behind them — the CSV importer, the smoke
 * test, cron. It is a *fallback*, not a default parameter, so it appears in one place and can
 * be read; scattering `?? ownerId` through twenty call sites is how a holding ends up on the
 * wrong account without anybody choosing that.
 */
async function requireOwnerId(userId?: number): Promise<number> {
  if (userId) return userId;
  const owner = await one<{ id: number }>(
    `SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
  if (!owner) throw new Error('no owner account exists — run the migrations');
  return owner.id;
}

/**
 * Resolve to a SKU, creating the parallel and/or SKU when you're the first to
 * record that version. A parallel named here but absent from the checklist is
 * added as user-declared rather than rejected — checklists are incomplete, and
 * refusing the card is worse than carrying an extra parallel row.
 */
export async function resolveOrCreateSku(input: AddHoldingInput): Promise<number> {
  if (input.skuId) return input.skuId;

  let cardId = input.cardId ?? null;
  if (!cardId && input.legacyId) {
    const c = await one<{ id: number }>(`SELECT id FROM cards WHERE legacy_id = $1`, [input.legacyId]);
    cardId = c?.id ?? null;
  }
  if (!cardId) throw new Error('skuId, cardId or legacyId is required');

  const card = await one<{ product_code: string; section: string; player: string; card_number: string }>(
    `SELECT product_code, section, player, card_number FROM cards WHERE id = $1`, [cardId],
  );
  if (!card) throw new Error(`card ${cardId} not found`);

  // --- parallel -----------------------------------------------------------
  let parallelId: number | null = null;
  /**
   * A print run with no colour word still is not the base card.
   *
   * Previously only a *named* parallel created one, so `{cardId, printRun: 37}` — which is
   * what you get from "#91 ronaldo <unrecognised colour> /37" — recorded the base card and
   * threw the /37 away. That is the worst possible outcome: silent, permanent, and it prices
   * a numbered parallel off base comps. `resolveSku` already solved this for ingest with an
   * `Unidentified /N` row; do the same here so both entry paths agree.
   */
  const parName = input.parallelName?.trim()
    || (input.printRun ? `Unidentified /${input.printRun}` : '');
  if (parName) {
    const existing = await one<{ id: number }>(
      `SELECT id FROM parallels
        WHERE product_code = $1 AND section = $2
          AND unaccent(lower(name)) = unaccent(lower($3))
        LIMIT 1`,
      [card.product_code, card.section, parName],
    );
    if (existing) {
      parallelId = existing.id;
    } else {
      const run = input.printRun ?? printRunFromParallelName(parName);
      const created = await one<{ id: number }>(
        `INSERT INTO parallels (product_code, section, name, print_run)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_code, section, name) DO UPDATE SET
           print_run = COALESCE(EXCLUDED.print_run, parallels.print_run)
         RETURNING id`,
        [card.product_code, card.section, parName, run],
      );
      parallelId = created!.id;
      log.info({ product: card.product_code, section: card.section, name: parName },
        'declared a parallel that was not on the checklist');
    }
  }

  // --- grade --------------------------------------------------------------
  let grader = input.grader?.trim().toUpperCase() || null;
  if (grader && !GRADERS.has(grader)) throw new Error(`unknown grading company "${grader}"`);
  const grade = input.grade == null ? null : Number(input.grade);
  if (grade != null && (!Number.isFinite(grade) || grade < 1 || grade > 10)) {
    throw new Error('grade must be between 1 and 10');
  }
  if (grade != null && !grader) grader = 'PSA';   // a bare number means PSA in practice

  const label = await buildLabel(cardId, parallelId, grader, grade);
  const row = await one<{ id: number }>(
    `INSERT INTO skus (card_id, parallel_id, grader, grade, label)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (card_id, parallel_id, grader, grade) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [cardId, parallelId, grader, grade, label],
  );
  return row!.id;
}

export async function addHolding(input: AddHoldingInput) {
  const userId = await requireOwnerId(input.userId);
  const skuId = await resolveOrCreateSku(input);
  const qty = Math.max(0, Math.round(Number(input.qty ?? 1)));

  if (qty === 0) {
    await q(`DELETE FROM holdings WHERE sku_id = $1 AND user_id = $2`, [skuId, userId]);
    return { skuId, removed: true };
  }

  const row = await one(
    `INSERT INTO holdings
       (user_id, sku_id, qty, cost_basis_aud, acquired_at, box_id, acquired_from, condition,
        price_override_aud, notes)
     VALUES ($10,$1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, sku_id) DO UPDATE SET
       qty = holdings.qty + EXCLUDED.qty,
       cost_basis_aud   = COALESCE(EXCLUDED.cost_basis_aud, holdings.cost_basis_aud),
       acquired_at      = COALESCE(EXCLUDED.acquired_at, holdings.acquired_at),
       box_id           = COALESCE(EXCLUDED.box_id, holdings.box_id),
       acquired_from    = COALESCE(EXCLUDED.acquired_from, holdings.acquired_from),
       condition        = COALESCE(EXCLUDED.condition, holdings.condition),
       price_override_aud = COALESCE(EXCLUDED.price_override_aud, holdings.price_override_aud),
       notes            = COALESCE(EXCLUDED.notes, holdings.notes),
       updated_at = now()
     RETURNING *`,
    [skuId, qty, input.costBasisAud ?? null, input.acquiredAt ?? null, input.boxId ?? null,
     input.acquiredFrom ?? null, input.condition ?? null, input.priceOverrideAud ?? null,
     input.notes ?? null, userId],
  );
  return { skuId, holding: row };
}

/**
 * Overwrite rather than increment — for editing an existing line.
 *
 * `user_id` is in the WHERE clause, not merely used to find the row: without it, editing by
 * `sku_id` alone would update whichever copy of that card the database happened to return
 * first, which once two people own Mora #214 means editing a stranger's card.
 */
export async function setHolding(skuId: number, input: AddHoldingInput) {
  const userId = await requireOwnerId(input.userId);
  const qty = Math.max(0, Math.round(Number(input.qty ?? 0)));
  if (qty === 0) {
    await q(`DELETE FROM holdings WHERE sku_id = $1 AND user_id = $2`, [skuId, userId]);
    return { skuId, removed: true };
  }
  const row = await one(
    `UPDATE holdings SET qty = $2, cost_basis_aud = $3, acquired_at = $4, box_id = $5,
            acquired_from = $6, condition = $7, price_override_aud = $8, notes = $9,
            updated_at = now()
      WHERE sku_id = $1 AND user_id = $10 RETURNING *`,
    [skuId, qty, input.costBasisAud ?? null, input.acquiredAt ?? null, input.boxId ?? null,
     input.acquiredFrom ?? null, input.condition ?? null, input.priceOverrideAud ?? null,
     input.notes ?? null, userId],
  );
  return { skuId, holding: row };
}

// ---------------------------------------------------------------------------
// Custom cards
// ---------------------------------------------------------------------------

export interface CustomCardInput {
  player: string;
  team?: string | null;
  cardNumber?: string | null;
  section?: string | null;
  productCode?: string | null;   // 'A' | 'B' | 'X'
  setName?: string | null;       // free text, used when productCode is 'X'
  year?: string | null;
  isRookie?: boolean;
  isAuto?: boolean;
  seedEstAud?: number | null;
  notes?: string | null;
}

/**
 * Create a card that isn't on the checklist.
 *
 * It gets a `C|` legacy id and `is_custom = true`, which keeps it out of the
 * reference-data uniqueness constraint and lets the UI mark it as yours rather
 * than as a licensed checklist entry. Everything downstream — pricing, matching,
 * recommendations — then treats it identically to a real card.
 */
export async function createCustomCard(input: CustomCardInput) {
  const player = input.player?.trim();
  if (!player) throw new Error('player is required');

  /**
   * Which product this card belongs to.
   *
   * C, D and E (Prizm, Select, Topps Chrome) carry parallels but no seeded checklist — see
   * migration 014 — so every card in them arrives through here. That is the intended path, not
   * a fallback: `is_custom` marks a row as user-created, which is exactly what these are, and
   * everything downstream prices and recommends them identically.
   *
   * Anything unrecognised still lands in 'X'. Silently accepting an arbitrary code would let a
   * typo create a fourth product nobody can find again.
   */
  const productCode = ['A', 'B', 'C', 'D', 'E', 'X'].includes(String(input.productCode))
    ? input.productCode! : 'X';
  const section = input.section?.trim() || 'Custom';
  const cardNumber = input.cardNumber?.trim().replace(/^#/, '') || '—';
  const team = input.team?.trim() || null;

  const searchText = [player, team, section, cardNumber, input.setName, input.year,
    input.isRookie ? 'Rookie' : ''].filter(Boolean).join(' ');

  // Deterministic id from the card's identity, so adding the same card twice
  // updates it instead of creating a duplicate.
  const legacyId = 'C|' + createHash('sha1')
    .update([productCode, section, cardNumber, player.toLowerCase(), input.setName ?? ''].join('|'))
    .digest('hex').slice(0, 12);

  const row = await one<{ id: number; legacy_id: string }>(
    `INSERT INTO cards (legacy_id, product_code, section, card_number, player, team, subset,
                        is_rookie, is_auto, is_insert, seed_est_aud, hot, search_text,
                        is_custom, set_name, card_year, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE,$12,TRUE,$13,$14,$15)
     ON CONFLICT (legacy_id) DO UPDATE SET
       player = EXCLUDED.player, team = EXCLUDED.team,
       seed_est_aud = COALESCE(EXCLUDED.seed_est_aud, cards.seed_est_aud),
       set_name = EXCLUDED.set_name, card_year = EXCLUDED.card_year,
       notes = EXCLUDED.notes, search_text = EXCLUDED.search_text
     RETURNING id, legacy_id`,
    [legacyId, productCode, section, cardNumber, player, team, input.isRookie ? 'RR' : '',
     !!input.isRookie, !!input.isAuto, section !== 'Base', input.seedEstAud ?? null,
     searchText, input.setName?.trim() || null, input.year?.trim() || null,
     input.notes?.trim() || null],
  );

  // Every card needs a raw base SKU so there's something to price and hold.
  const label = await buildLabel(row!.id, null, null, null);
  const sku = await one<{ id: number }>(
    `INSERT INTO skus (card_id, parallel_id, grader, grade, label) VALUES ($1,NULL,NULL,NULL,$2)
       ON CONFLICT (card_id, parallel_id, grader, grade) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
    [row!.id, label],
  );

  log.info({ cardId: row!.id, player, productCode, section }, 'custom card created');
  return { cardId: row!.id, legacyId: row!.legacy_id, skuId: sku!.id };
}

export async function deleteCustomCard(cardId: number) {
  const c = await one<{ is_custom: boolean }>(`SELECT is_custom FROM cards WHERE id = $1`, [cardId]);
  if (!c) throw new Error('card not found');
  if (!c.is_custom) throw new Error('only custom cards can be deleted — checklist entries are reference data');
  await q(`DELETE FROM cards WHERE id = $1`, [cardId]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Your own photographs
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
};

/** Verify the bytes really are an image, rather than trusting the declared type. */
function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp'
    && /avif|mif1/.test(buf.subarray(8, 12).toString('ascii'))) return 'image/avif';
  return null;
}

/**
 * Store your own photo for a SKU.
 *
 * SUPERSEDED by `src/photos.ts`. Nothing calls this any more.
 *
 * It writes ONE photo per SKU for the whole database, which was right while the database was
 * one person and became a data-loss bug the moment it was not: the second person to
 * photograph a card they both own replaces the first person's file, and the unlink below
 * removes it from disk. Photographs are now keyed (user, sku, side) — see
 * `db/migrations/015_card_photos.sql`.
 *
 * Kept, not deleted, for one reason: `skus.image_path` still holds the photos written by this
 * function before the change, and `/api/img/:skuId` still serves them as a fallback. Deleting
 * the writer while the reader survives is how you end up unable to explain where an image
 * came from. It should go once those rows are migrated or gone.
 *
 * Accepts a data URL or bare base64 so the browser can post it as JSON with no
 * multipart dependency. The magic bytes are checked rather than the declared
 * content type — a file input will happily hand you a renamed .exe.
 *
 * @deprecated use `savePhoto` from `./photos.js`
 */
export async function saveOwnPhoto(skuId: number, dataUrlOrBase64: string) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrlOrBase64.trim());
  const b64 = (m ? m[3]! : dataUrlOrBase64).replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');

  if (buf.length === 0) throw new Error('no image data');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`image is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 8 MB`);
  }
  const mime = sniffMime(buf);
  if (!mime) throw new Error('that does not look like an image file (JPEG, PNG, WebP, GIF or AVIF)');

  const sku = await one<{ id: number; image_path: string | null }>(
    `SELECT id, image_path FROM skus WHERE id = $1`, [skuId],
  );
  if (!sku) throw new Error(`sku ${skuId} not found`);

  const dir = join(cfg.IMAGE_CACHE_DIR, 'uploads');
  await mkdir(dir, { recursive: true });
  const ext = MIME_EXT[mime] ?? 'jpg';
  const name = `sku-${skuId}-${createHash('sha1').update(buf).digest('hex').slice(0, 10)}.${ext}`;
  const path = join(dir, name);
  await writeFile(path, buf);

  // Replacing a photo shouldn't leave the old file behind.
  if (sku.image_path && sku.image_path !== path) await unlink(sku.image_path).catch(() => {});

  await q(
    `UPDATE skus SET image_path = $2, image_url = NULL, image_source = 'upload',
            image_listing_id = NULL, image_updated_at = now()
      WHERE id = $1`,
    [skuId, path],
  );
  log.info({ skuId, bytes: buf.length, mime }, 'own photo stored');
  return { ok: true, skuId, bytes: buf.length, mime };
}

/** @deprecated the shared-photo twin of `saveOwnPhoto`; use `deletePhoto` from `./photos.js` */
export async function deleteOwnPhoto(skuId: number) {
  const sku = await one<{ image_path: string | null }>(`SELECT image_path FROM skus WHERE id = $1`, [skuId]);
  if (sku?.image_path) await unlink(sku.image_path).catch(() => {});
  await q(
    `UPDATE skus SET image_path = NULL, image_source = NULL, image_updated_at = now() WHERE id = $1`,
    [skuId],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------

async function buildLabel(cardId: number, parallelId: number | null, grader: string | null, grade: number | null) {
  const c = await one<{ player: string; card_number: string; section: string; product_code: string; set_name: string | null }>(
    `SELECT player, card_number, section, product_code, set_name FROM cards WHERE id = $1`, [cardId],
  );
  const par = parallelId
    ? await one<{ name: string }>(`SELECT name FROM parallels WHERE id = $1`, [parallelId])
    : null;
  const setLabel = c?.set_name
    ?? productShort(c?.product_code);
  return [setLabel, c?.section, `#${c?.card_number}`, c?.player, par?.name,
    grader ? `${grader} ${grade ?? '?'}` : 'Raw'].filter(Boolean).join(' · ');
}
