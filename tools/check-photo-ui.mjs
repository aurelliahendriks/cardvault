/**
 * Photographing a card, in a real browser, on a phone-sized screen.
 *
 * `tools/check-photos.mjs` proves the API and the isolation. This proves the part a person
 * actually touches: that tapping "Take front" reaches the camera picker, that the shot goes
 * through the crop review and lands in the FRONT slot rather than replacing the back, that
 * the strip then shows it, and that a friend looking at the same card sees your photo but no
 * button that would let them destroy it.
 *
 * The last one is the reason this is a browser test and not another API test. The server
 * returns 403 either way; whether a friend is *shown* a Remove button is a question only the
 * rendered page can answer, and a button that always fails is its own kind of broken.
 *
 * Needs a running API and DATABASE_URL.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = process.env.B || 'http://localhost:8224';
const OUT = process.env.OUT || '/tmp/photo-ui';
mkdirSync(OUT, { recursive: true });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fails = [];
const note = [];
const ok = (c, m) => { if (!c) fails.push(m); else note.push(m); };

/** A card-shaped photo on a plain background, so the auto-cropper has something to find. */
function cardPhoto(path, hue) {
  const W = 800, H = 1000, cw = 380, ch = 532;          // 2.5:3.5 card in a wider frame
  const x0 = (W - cw) >> 1, y0 = (H - ch) >> 1;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const inCard = x >= x0 && x < x0 + cw && y >= y0 && y < y0 + ch;
      if (inCard) { px[i] = hue[0]; px[i + 1] = hue[1]; px[i + 2] = hue[2]; }
      else { px[i] = 232; px[i + 1] = 231; px[i + 2] = 226; }   // desk
    }
  }
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const idat = zlib.deflateSync(raw);
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
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]));
  return path;
}

// --- accounts -------------------------------------------------------------
const { createUser, findUser, setPassword } = await import('../src/auth.js');
for (const [name, pw] of [['ibi', 'test-password-1'], ['mate', 'test-password-2']]) {
  const existing = await findUser(name);
  if (existing) await setPassword(existing.id, pw);
  else await createUser({ username: name, password: pw, displayName: name });
}
await db.query(`UPDATE users SET role='owner' WHERE username='ibi'`);
await db.query(`DELETE FROM card_photos`);
await db.query(`DELETE FROM holdings`);

const SKU = (await db.query(`SELECT sku_id FROM sku_detail ORDER BY sku_id LIMIT 1`)).rows[0].sku_id;
const FRONT = cardPhoto(`${OUT}/front.png`, [40, 90, 200]);
const BACK = cardPhoto(`${OUT}/back.png`, [200, 90, 40]);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

/** Sign in and open the card dialog on a phone-sized viewport. */
async function openAs(username, password) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await p.goto(B, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  if (await p.locator('#gate').isVisible().catch(() => false)) {
    const chip = p.locator(`#gatePeople button:text-is("${username}")`);
    if (await chip.count()) await chip.first().click();
    else await p.fill('#liUser', username).catch(() => {});
    await p.fill('#liPass', password);
    await p.click('#liGo');
    await p.waitForTimeout(3000);
  }
  await p.evaluate((sku) => window.openCard(String(sku)), SKU);
  await p.waitForTimeout(2500);
  return { p, errs, ctx };
}

// The card has to be in somebody's collection for the dialog to be the real thing.
await (await b.newContext()).close();

// --- ibi photographs both sides ------------------------------------------
const A = await openAs('ibi', 'test-password-1');
{
  const { p, errs } = A;
  ok(await p.locator('#photoStrip').count() > 0, 'the card dialog has a photo strip');
  // Screenshots are evidence, and evidence above the fold is no evidence.
  await p.locator('#photoStrip').scrollIntoViewIfNeeded();
  const emptySlots = await p.locator('#photoStrip .ownshot-empty').count();
  ok(emptySlots === 2, `two empty slots before anything is shot (${emptySlots})`);
  await p.screenshot({ path: `${OUT}/1-empty.png` });

  for (const [side, file] of [['front', FRONT], ['back', BACK]]) {
    const chooser = p.waitForEvent('filechooser');
    await p.locator(`#photoStrip [data-shoot][data-side="${side}"]`).first().click();
    (await chooser).setFiles(file);
    await p.waitForSelector('#cropDlg[open]', { timeout: 8000 });
    const title = await p.locator('#cropTitle').textContent();
    ok(new RegExp(side).test(title), `the crop dialog says which side it is saving (${title})`);
    if (side === 'front') await p.screenshot({ path: `${OUT}/2-crop.png` });
    const canUse = await p.locator('#cropUse').isEnabled();
    ok(canUse, `the cropper found the card in the ${side} photo`);
    await p.click(canUse ? '#cropUse' : '#cropWhole');
    await p.waitForTimeout(2500);
  }

  const shots = await p.locator('#photoStrip .ownshot img').count();
  ok(shots === 2, `both sides now show in the strip (${shots})`);
  ok(await p.locator('#photoStrip .ownshot-empty').count() === 0, 'and no empty slot is left');
  await p.screenshot({ path: `${OUT}/3-both.png` });

  const rows = (await db.query(
    `SELECT side, cropped, bytes FROM card_photos p JOIN users u ON u.id=p.user_id
      WHERE u.username='ibi' AND p.sku_id=$1 ORDER BY side`, [SKU])).rows;
  ok(rows.length === 2, `two rows in the database (${rows.length})`);
  ok(rows.map((r) => r.side).join(',') === 'back,front', `one front and one back (${rows.map((r) => r.side)})`);
  ok(rows.every((r) => Number(r.bytes) > 0 && Number(r.bytes) < 8 * 1024 * 1024),
     'each is a sane size after cropping and re-encoding');
  ok(rows.every((r) => r.cropped === true), 'and is recorded as cropped, not the whole photo');

  /* The tile art should now be the person's own photograph — and this is two separate
     claims, which is why it is two assertions.

     The server can be perfectly correct and the screen still wrong, because the browser
     cached /api/img/<sku> while the card had no photo. That is not a hypothetical: with
     `cache: 'default'` this check failed while the server was already returning the right
     bytes. So: ask the server with the cache bypassed to test the server, and inspect the
     actual <img> element to test what the person sees. */
  const src = await p.evaluate(async (sku) => {
    const r = await fetch(`/api/img/${sku}`, { cache: 'reload' });
    return { source: r.headers.get('x-image-source'), vary: r.headers.get('vary'),
             cc: r.headers.get('cache-control') };
  }, SKU);
  ok(src.source === 'own-photo', `the server serves your own photo as the card image (${src.source})`);
  ok(/cookie/i.test(src.vary || ''), `and varies on the cookie so a cache cannot cross people (${src.vary})`);
  ok(/private/.test(src.cc || ''), `and is marked private (${src.cc})`);

  const shown = await p.evaluate(() => {
    const im = document.querySelector('.dlg .big img');
    return im ? im.getAttribute('src') : null;
  });
  ok(/\?v=\d+/.test(shown || ''),
     `the artwork on screen was repointed past the stale cached copy (${shown})`);

  ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);
}

// --- mate looks at the same card -----------------------------------------
const C = await openAs('mate', 'test-password-2');
{
  const { p, errs } = C;
  await p.waitForTimeout(1200);
  await p.locator('#photoStrip').scrollIntoViewIfNeeded();
  const theirs = await p.locator('#photoStrip .ownshot img').count();
  ok(theirs >= 2, `a friend can see your two photos (${theirs})`);
  const removable = await p.locator('#photoStrip [data-photodel]').count();
  ok(removable === 0, `and is shown no Remove button for them (${removable})`);
  const ownSlots = await p.locator('#photoStrip .ownshot-empty').count();
  ok(ownSlots === 2, `while their own two slots are still empty and inviting (${ownSlots})`);
  await p.screenshot({ path: `${OUT}/4-friend-view.png` });
  ok(errs.length === 0, `no page errors for the visitor (${errs.join(' | ')})`);
}

console.log(JSON.stringify({ passed: note.length, failed: fails.length, fails, note, screenshots: OUT }, null, 2));
await b.close();
await db.end();
process.exit(fails.length ? 1 : 0);
