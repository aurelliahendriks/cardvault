/**
 * Photographs of the cards you own.
 *
 * The database half of this is `db/migrations/015_card_photos.sql`, whose header explains why
 * a photo belongs to (user, sku, side) rather than to a holding or to a SKU alone. This file
 * is the other half: where the bytes go on disk, and the rules about who may move them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILES ARE NOT IN THE DATABASE
 * ---------------------------------------------------------------------------
 *
 * They live in a folder you can open in Explorer. Three reasons, in order of how much they
 * matter:
 *
 *  1. `docker compose down -v` deletes the database volume. It is a command people run when
 *     something is stuck, and it has already been called out as dangerous elsewhere in this
 *     project. A folder on the host survives it. Photographs of physical objects are the one
 *     kind of data here that genuinely cannot be regenerated — comps can be re-ingested,
 *     prices recomputed, the checklist re-seeded. A photo of a card you have since sold is
 *     gone forever.
 *  2. A pg_dump containing a few gigabytes of JPEG is slow to take, slow to restore, and
 *     awkward to inspect. The backup then fails at the worst possible time, which is the
 *     first time it is large.
 *  3. Being able to look at your photographs without the app running is worth something on
 *     its own.
 *
 * The cost is that the folder must be backed up separately, which is a real cost, and it is
 * why `tools/backup.ps1` was changed at the same time as this file rather than afterwards.
 *
 * ---------------------------------------------------------------------------
 * PATHS
 * ---------------------------------------------------------------------------
 *
 * The layout is meant to be read by a human:
 *
 *     photos/ibi/lamine-yamal-prizm-245-pink-power-sku1841/front.jpg
 *
 * The stored path is relative to the root, and every path that comes back OUT of the database
 * is re-resolved and checked for containment before it is opened. That check is not because
 * the paths are untrusted today — they are written by this file — but because "the database
 * only ever contains safe paths" is an invariant that survives exactly until somebody adds an
 * import tool.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';
import { cfg } from './config.js';
import { q, one } from './db.js';
import { log } from './logger.js';

export type Side = 'front' | 'back';
export const SIDES: Side[] = ['front', 'back'];

/** 8 MB, matching the existing upload path. A cropped card at 1400px is well under 1 MB. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif',
};

/**
 * Verify the bytes really are an image rather than trusting the declared type.
 *
 * A copy of the sniffer in `collection.ts` on purpose: that one guards the old shared-photo
 * path, this one guards the new per-person path, and the day one of them needs to change
 * (a new format, a tightened rule) is not necessarily the day the other does.
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp'
    && /avif|mif1/.test(buf.subarray(8, 12).toString('ascii'))) return 'image/avif';
  return null;
}

export const photoRoot = () => resolve(cfg.PHOTO_DIR);

/**
 * Turn a label into something safe to be a folder name on Windows, macOS and Linux at once.
 *
 * Windows is the strict one and this app runs on it: `< > : " / \ | ? *` are illegal, names
 * cannot end in a dot or space, and CON/PRN/AUX/NUL/COM1-9/LPT1-9 are reserved device names
 * that fail in confusing ways rather than obviously. Accents are folded rather than dropped
 * so "Mbappé" becomes "mbappe" and not "mbapp".
 */
export function slug(s: string, max = 64): string {
  const base = s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  if (!base) return 'untitled';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base) ? `${base}-x` : base;
}

/**
 * The folder for one person's copy of one card.
 *
 * The SKU id is appended rather than trusted to be implied by the label, because two SKUs can
 * slug identically — a long player name truncated at 64 characters, or a parallel that differs
 * only in punctuation. Without it, one card's photographs would land in another card's folder
 * and the `UNIQUE (user_id, sku_id, side)` row would point at a file that had been overwritten.
 */
export function skuFolder(username: string, skuId: number, label: string | null): string {
  const pretty = slug(
    (label ?? `sku ${skuId}`)
      // The label reads "Prizm FIFA 25/26 · Base · #245 · Lamine Yamal · Pink Power (#/75) · Raw".
      // Strip the separators and the noise that is the same on every card.
      .replace(/·/g, ' ')
      .replace(/#\/\d+/g, '')
      .replace(/\bRaw\b/g, ''),
    60,
  );
  return join(slug(username, 32), `${pretty}-sku${skuId}`);
}

/**
 * Resolve a stored relative path against the root and refuse anything that escapes it.
 *
 * `resolve()` collapses `..` before the comparison, so `../../etc/passwd` becomes an absolute
 * path outside the root and fails the prefix test rather than sneaking through it. The
 * trailing separator on the root matters: without it, a sibling folder named `photos-evil`
 * would pass a naive `startsWith('/data/photos')`.
 *
 * The backslash handling is not paranoia about Windows aesthetics, it is about the check
 * meaning the same thing in both places this code runs. The app runs on Linux inside the
 * container, where `..\..\windows\system32` is ONE legal filename and `resolve()` therefore
 * reports it as safely inside the root — while the folder it writes into is a bind mount on
 * a Windows disk, where the same string is four levels of traversal. A guard whose verdict
 * depends on which side of the mount you ask is not a guard. So segments are split on both
 * separators and `..` is rejected outright, before `resolve()` gets a chance to have an
 * opinion.
 */
export function resolveInRoot(relPath: string): string {
  const root = photoRoot();
  const segments = String(relPath).split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error('photo path escapes the photo folder');
  }
  // An absolute path, or a Windows drive/UNC path, is never a valid stored value.
  if (/^([a-zA-Z]:|[\\/])/.test(String(relPath))) {
    throw new Error('photo path must be relative to the photo folder');
  }
  const full = resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('photo path escapes the photo folder');
  }
  return full;
}

export interface SavedPhoto {
  id: number;
  skuId: number;
  side: Side;
  relPath: string;
  bytes: number;
  mime: string;
  replaced: boolean;
}

/**
 * Store one side of one card for one person.
 *
 * Idempotent on the bytes: re-uploading the identical photo to the same slot rewrites nothing
 * and returns the existing row. Phones retry uploads on flaky connections, and the honest
 * answer to "this is already there" is not a second copy.
 */
export async function savePhoto(opts: {
  userId: number;
  username: string;
  skuId: number;
  side: Side;
  dataUrl: string;
  cropped?: boolean;
  width?: number | null;
  height?: number | null;
}): Promise<SavedPhoto> {
  if (!SIDES.includes(opts.side)) throw new Error(`side must be front or back`);

  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(opts.dataUrl.trim());
  const b64 = (m ? m[3]! : opts.dataUrl).replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');

  if (buf.length === 0) throw new Error('no image data');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`image is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 8 MB`);
  }
  const mime = sniffMime(buf);
  if (!mime) throw new Error('that does not look like an image file (JPEG, PNG, WebP, GIF or AVIF)');

  const sku = await one<{ id: number; label: string | null }>(
    `SELECT id, label FROM skus WHERE id = $1`, [opts.skuId],
  );
  if (!sku) throw new Error(`card ${opts.skuId} not found`);

  const sha = createHash('sha256').update(buf).digest('hex');
  const existing = await one<{ id: number; rel_path: string; sha256: string }>(
    `SELECT id, rel_path, sha256 FROM card_photos
      WHERE user_id = $1 AND sku_id = $2 AND side = $3`,
    [opts.userId, opts.skuId, opts.side],
  );

  if (existing && existing.sha256 === sha) {
    return { id: existing.id, skuId: opts.skuId, side: opts.side, relPath: existing.rel_path,
             bytes: buf.length, mime, replaced: false };
  }

  const relPath = join(skuFolder(opts.username, opts.skuId, sku.label),
                       `${opts.side}.${MIME_EXT[mime] ?? 'jpg'}`);
  const full = resolveInRoot(relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buf);

  // Re-shooting in a different format leaves `front.png` behind next to the new `front.jpg`,
  // and the folder is meant to be browsable by a person, so the stale file goes.
  if (existing && existing.rel_path !== relPath) {
    await unlink(resolveInRoot(existing.rel_path)).catch(() => {});
  }

  const row = await one<{ id: number }>(
    `INSERT INTO card_photos (user_id, sku_id, side, rel_path, sha256, bytes, mime,
                              width, height, cropped, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (user_id, sku_id, side) DO UPDATE SET
       rel_path = EXCLUDED.rel_path, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
       mime = EXCLUDED.mime, width = EXCLUDED.width, height = EXCLUDED.height,
       cropped = EXCLUDED.cropped, updated_at = now()
     RETURNING id`,
    [opts.userId, opts.skuId, opts.side, relPath, sha, buf.length, mime,
     opts.width ?? null, opts.height ?? null, opts.cropped ?? false],
  );

  log.info({ userId: opts.userId, skuId: opts.skuId, side: opts.side, bytes: buf.length, relPath },
           'card photo stored');
  return { id: row!.id, skuId: opts.skuId, side: opts.side, relPath,
           bytes: buf.length, mime, replaced: !!existing };
}

export interface PhotoRow {
  id: number;
  skuId: number;
  side: Side;
  bytes: number;
  mime: string;
  width: number | null;
  height: number | null;
  cropped: boolean;
  capturedAt: string;
  userId: number;
  ownerName: string;
  mine: boolean;
  url: string;
}

/** Every photograph of a card, whoever took it. Reading is shared; writing is not. */
export async function listPhotos(skuId: number, viewerId: number | null): Promise<PhotoRow[]> {
  const rows = await q<any>(
    `SELECT id, sku_id, side, bytes, mime, width, height, cropped, captured_at,
            user_id, owner_name
       FROM card_photo_index
      WHERE sku_id = $1
      ORDER BY (user_id = $2) DESC, owner_name, side DESC`,
    [skuId, viewerId ?? -1],
  );
  return rows.map((r) => ({
    id: Number(r.id), skuId: Number(r.sku_id), side: r.side as Side,
    bytes: Number(r.bytes), mime: r.mime,
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    cropped: r.cropped, capturedAt: r.captured_at,
    userId: Number(r.user_id), ownerName: r.owner_name,
    mine: viewerId != null && Number(r.user_id) === viewerId,
    url: `/api/photos/file/${r.id}`,
  }));
}

/** The bytes for one photograph, by id. No client-supplied path is ever opened. */
export async function readPhoto(photoId: number): Promise<{ body: Buffer; mime: string } | null> {
  const row = await one<{ rel_path: string; mime: string }>(
    `SELECT rel_path, mime FROM card_photos WHERE id = $1`, [photoId],
  );
  if (!row) return null;
  try {
    return { body: await readFile(resolveInRoot(row.rel_path)), mime: row.mime };
  } catch {
    // The file is gone — the folder was moved, or somebody tidied up in Explorer. Drop the
    // row so the gallery stops promising a photograph that does not exist.
    await q(`DELETE FROM card_photos WHERE id = $1`, [photoId]);
    log.warn({ photoId, relPath: row.rel_path }, 'photo file missing; row removed');
    return null;
  }
}

/**
 * Delete one of your own photographs.
 *
 * Returns `notMine` rather than throwing when the photo belongs to somebody else, so the
 * route can answer 403 and the caller can be told the truth. The check is on the row's
 * `user_id`, never on anything the client sent.
 */
export async function deletePhoto(photoId: number, userId: number):
  Promise<{ ok: boolean; notMine?: boolean; missing?: boolean }> {
  const row = await one<{ id: number; user_id: number; rel_path: string }>(
    `SELECT id, user_id, rel_path FROM card_photos WHERE id = $1`, [photoId],
  );
  if (!row) return { ok: false, missing: true };
  if (Number(row.user_id) !== userId) return { ok: false, notMine: true };

  await unlink(resolveInRoot(row.rel_path)).catch(() => {});
  // Tidy the card folder if that was its last photograph. `rm` with recursive:false on a
  // non-empty directory fails, which is exactly the guard wanted — the other side stays.
  await rm(dirname(resolveInRoot(row.rel_path)), { recursive: false }).catch(() => {});
  await q(`DELETE FROM card_photos WHERE id = $1`, [photoId]);
  return { ok: true };
}

/**
 * How many cards you have photographed, and how much disk it is using.
 *
 * On the dashboard because "I have photographed 40 of my 120 cards" is the question a person
 * actually has mid-way through cataloguing, and because a folder quietly growing to 20 GB
 * should be visible before the disk fills rather than after.
 */
export async function photoStats(userId: number | null) {
  const row = await one<any>(
    `SELECT count(*)::int                                    AS photos,
            count(DISTINCT sku_id)::int                      AS cards,
            count(*) FILTER (WHERE side = 'front')::int      AS fronts,
            count(*) FILTER (WHERE side = 'back')::int       AS backs,
            COALESCE(sum(bytes), 0)::bigint                  AS bytes
       FROM card_photos
      WHERE $1::bigint IS NULL OR user_id = $1`,
    [userId],
  );
  return {
    photos: row?.photos ?? 0,
    cards: row?.cards ?? 0,
    fronts: row?.fronts ?? 0,
    backs: row?.backs ?? 0,
    bytes: Number(row?.bytes ?? 0),
    folder: photoRoot(),
  };
}
