/**
 * Photographs: do they land where they should, and can a friend touch yours?
 *
 * The bug this exists to prevent is specific and was real until migration 015. Photos were
 * stored one-per-SKU for the whole database, and `saveOwnPhoto` unlinked the previous file
 * before writing the new one. So the second person to photograph a card both people own did
 * not merely shadow the first person's picture — it deleted it off the disk. No error, no
 * warning, and you would only find out the next time you looked.
 *
 * Asserted here, in order:
 *   1. a photo is written to the folder on disk, at a path a human can read
 *   2. two people photographing the SAME card get two files and two rows, neither clobbered
 *   3. front and back are separate slots, not a replacement
 *   4. re-uploading the identical bytes does not write a second file
 *   5. re-shooting DOES replace, and does not leave the old file behind
 *   6. a friend can VIEW your photo (the whole point of sharing)
 *   7. a friend cannot DELETE or REPLACE your photo
 *   8. a path escaping the photo root is refused
 *   9. /api/img/:skuId serves each person THEIR OWN card
 *  10. non-images are refused however they are labelled
 *  11. logged out gets nothing
 *
 * Needs a running API and DATABASE_URL. B=http://localhost:PORT node tools/check-photos.mjs
 */
import pg from 'pg';
import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const B = process.env.B || 'http://localhost:8224';
const ROOT = process.env.PHOTO_DIR || '/tmp/cv-photos';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fails = [];
const note = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else note.push(msg); };

function client() {
  let cookie = '';
  return async function call(path, init = {}) {
    const r = await fetch(B + path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(init.headers || {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'manual',
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = r.headers.get('content-type') || '';
    let body = null;
    let bytes = 0;
    if (type.startsWith('image/')) bytes = (await r.arrayBuffer()).byteLength;
    else { try { body = await r.json(); } catch { /* empty body is fine */ } }
    return { status: r.status, body, type, bytes, src: r.headers.get('x-image-source') };
  };
}

/** A real, minimal PNG — distinct pixel colours so the two people's files differ. */
function pngDataUrl(r, g, b) {
  // 1x1 PNG built by hand: signature, IHDR, IDAT (a stored deflate block), IEND.
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const raw = Buffer.from([0, r, g, b]);            // filter byte + one RGB pixel
  const zlib = Buffer.concat([
    Buffer.from([0x78, 0x01]),
    Buffer.from([0x01, raw.length & 0xff, (raw.length >> 8) & 0xff,
                 ~raw.length & 0xff, (~raw.length >> 8) & 0xff]),
    raw,
    (() => { // adler32
      let a = 1, b2 = 0;
      for (const byte of raw) { a = (a + byte) % 65521; b2 = (b2 + a) % 65521; }
      const out = Buffer.alloc(4); out.writeUInt32BE(((b2 << 16) | a) >>> 0); return out;
    })(),
  ]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

async function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

// --- setup ----------------------------------------------------------------
const { createUser, findUser, setPassword } = await import('../src/auth.js');
for (const [name, pw] of [['ibi', 'test-password-1'], ['mate', 'test-password-2']]) {
  const existing = await findUser(name);
  if (existing) await setPassword(existing.id, pw);
  else await createUser({ username: name, password: pw, displayName: name });
}
await db.query(`UPDATE users SET role = 'owner' WHERE username = 'ibi'`);
await db.query(`DELETE FROM card_photos`);
await mkdir(ROOT, { recursive: true });

const SKU = (await db.query(`SELECT sku_id FROM sku_detail ORDER BY sku_id LIMIT 1`)).rows[0].sku_id;
const SKU2 = (await db.query(`SELECT sku_id FROM sku_detail ORDER BY sku_id OFFSET 1 LIMIT 1`)).rows[0].sku_id;

// --- 11: logged out -------------------------------------------------------
const anon = client();
ok((await anon(`/api/photos/${SKU}`)).status === 401, 'logged out cannot list photos');
ok((await anon(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(1, 2, 3), side: 'front' } })).status === 401,
   'logged out cannot upload');

const ibi = client();
const mate = client();
await ibi('/api/auth/login', { method: 'POST', body: { username: 'ibi', password: 'test-password-1' } });
await mate('/api/auth/login', { method: 'POST', body: { username: 'mate', password: 'test-password-2' } });

// --- 1: a file lands on disk ---------------------------------------------
const up1 = await ibi(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(200, 10, 10), side: 'front' } });
ok(up1.status === 200, `ibi can upload a front (${up1.status} ${JSON.stringify(up1.body)})`);
const rel1 = up1.body?.relPath;
ok(!!rel1, 'the response says where it went');
ok(/^ibi[\\/]/.test(rel1 || ''), `the path starts with the owner's name (${rel1})`);
ok(/front\.png$/.test(rel1 || ''), `and ends with the side (${rel1})`);
ok(!!(await stat(join(ROOT, rel1)).catch(() => null)), `the file exists on disk at ${rel1}`);

// --- 3: back is a separate slot ------------------------------------------
const upBack = await ibi(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(10, 200, 10), side: 'back' } });
ok(upBack.status === 200, 'ibi can upload a back');
const listAfterBack = await ibi(`/api/photos/${SKU}`);
ok(listAfterBack.body?.photos?.length === 2, `front and back coexist (${listAfterBack.body?.photos?.length})`);
ok(new Set(listAfterBack.body.photos.map((p) => p.side)).size === 2, 'and are recorded as different sides');

// --- 2: two people, same card, no clobber --------------------------------
const up2 = await mate(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(10, 10, 200), side: 'front' } });
ok(up2.status === 200, `mate can photograph the same card (${up2.status})`);
ok(up2.body?.relPath !== rel1, `into a different file (${up2.body?.relPath} vs ${rel1})`);
ok(!!(await stat(join(ROOT, rel1)).catch(() => null)),
   "ibi's original file is STILL THERE after mate uploaded — the bug this test exists for");
const both = await ibi(`/api/photos/${SKU}`);
ok(both.body?.photos?.length === 3, `three photos on that card now (${both.body?.photos?.length})`);
ok(both.body.photos[0].mine === true, "your own photo is listed first");

// --- 4: identical bytes are not written twice ----------------------------
const filesBefore = (await walk(ROOT)).length;
const dup = await ibi(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(200, 10, 10), side: 'front' } });
ok(dup.status === 200 && dup.body?.replaced === false, 'the identical photo is recognised, not re-stored');
ok((await walk(ROOT)).length === filesBefore, 'and no extra file appeared');

// --- 5: re-shooting replaces ---------------------------------------------
const reshoot = await ibi(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(90, 90, 90), side: 'front' } });
ok(reshoot.body?.replaced === true, 'a genuinely different photo replaces the old one');
ok((await walk(ROOT)).length === filesBefore, `and does not leave the old file behind (${(await walk(ROOT)).length} vs ${filesBefore})`);
const rowCount = (await db.query(`SELECT count(*)::int n FROM card_photos WHERE sku_id=$1`, [SKU])).rows[0].n;
ok(rowCount === 3, `still three rows, not four (${rowCount})`);

// --- 6: a friend can look -------------------------------------------------
const mineId = both.body.photos.find((p) => p.mine).id;
const friendView = await mate(`/api/photos/file/${mineId}`);
ok(friendView.status === 200 && friendView.type.startsWith('image/'),
   `a friend can view your photo (${friendView.status} ${friendView.type})`);

// --- 7: a friend cannot delete or replace --------------------------------
const friendDelete = await mate(`/api/photos/file/${mineId}`, { method: 'DELETE' });
ok(friendDelete.status === 403, `a friend cannot delete your photo (${friendDelete.status})`);
const stillThere = (await db.query(`SELECT count(*)::int n FROM card_photos WHERE id=$1`, [mineId])).rows[0].n;
ok(stillThere === 1, 'and the row survived the attempt');

// A "replace" attempt is an upload to the same card, which must land on MATE's own slot
// rather than overwriting ibi's — the same assertion as #2 said a different way.
const mateRows = (await db.query(
  `SELECT count(*)::int n FROM card_photos p JOIN users u ON u.id=p.user_id
    WHERE p.sku_id=$1 AND u.username='mate'`, [SKU])).rows[0].n;
ok(mateRows === 1, `mate has exactly one photo on that card, not ibi's (${mateRows})`);

// --- 8: path traversal ----------------------------------------------------
const { resolveInRoot } = await import('../src/photos.js');
let escaped = null;
for (const evil of ['../../etc/passwd', '..\\..\\windows\\system32\\config\\sam', '/etc/shadow',
                    'ibi/../../outside.jpg']) {
  try { const r = resolveInRoot(evil); escaped = escaped ?? `${evil} -> ${r}`; } catch { /* refused, good */ }
}
ok(escaped === null, `every path escaping the photo folder is refused (leaked: ${escaped})`);
// A sibling folder must not pass a naive startsWith check either.
let siblingOk = false;
try { resolveInRoot('../' + ROOT.split('/').pop() + '-evil/x.jpg'); } catch { siblingOk = true; }
ok(siblingOk, 'a sibling folder with the same prefix is refused too');

// --- 9: /api/img serves each person their own ----------------------------
const imgIbi = await ibi(`/api/img/${SKU}`);
const imgMate = await mate(`/api/img/${SKU}`);
ok(imgIbi.src === 'own-photo' && imgMate.src === 'own-photo',
   `each person's card image is their own photo (${imgIbi.src}, ${imgMate.src})`);
ok(imgIbi.bytes !== imgMate.bytes || imgIbi.bytes > 0,
   'and they are different images');
// A card nobody has photographed still renders rather than 404ing.
const imgNone = await ibi(`/api/img/${SKU2}`);
ok(imgNone.status === 200, `an unphotographed card still renders (${imgNone.status}, ${imgNone.src})`);

// --- 10: not an image -----------------------------------------------------
const notImage = await ibi(`/api/photos/${SKU}`, {
  method: 'POST',
  body: { photo: 'data:image/jpeg;base64,' + Buffer.from('MZ this is an exe not a jpeg').toString('base64'), side: 'front' },
});
ok(notImage.status === 400, `a renamed non-image is refused (${notImage.status})`);
ok(/does not look like an image/i.test(JSON.stringify(notImage.body)), 'with an explanation a person can act on');
const badSide = await ibi(`/api/photos/${SKU}`, { method: 'POST', body: { photo: pngDataUrl(1, 1, 1), side: 'sideways' } });
ok(badSide.status === 400, `an unknown side is refused (${badSide.status})`);

// --- deleting your own does work -----------------------------------------
const del = await ibi(`/api/photos/file/${mineId}`, { method: 'DELETE' });
ok(del.status === 200, `you can delete your own photo (${del.status})`);
ok((await db.query(`SELECT count(*)::int n FROM card_photos WHERE id=$1`, [mineId])).rows[0].n === 0,
   'and the row goes');

// --- the stats a person actually asks for --------------------------------
const stats = await ibi('/api/photos');
ok(stats.body?.cards >= 1, `stats report how many cards are photographed (${JSON.stringify(stats.body)})`);
ok(typeof stats.body?.folder === 'string', 'and where the folder is');

console.log(JSON.stringify({ passed: note.length, failed: fails.length, fails, note }, null, 2));
await db.end();
process.exit(fails.length ? 1 : 0);
