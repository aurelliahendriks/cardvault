/**
 * Auto-crop and home-screen install, in a real browser.
 *
 * The crop *algorithm* is unit-tested in test/cardcrop.test.ts. This checks the things a unit
 * test cannot: that a file chosen through a real file input reaches the analyser, that the
 * proposed box is drawn where the person can see it, that "use this crop" produces a smaller
 * image than went in, and that a photo the analyser refuses cannot be cropped by accident.
 *
 * The PWA half checks the two mechanisms separately, because they are separate: Chrome reads
 * manifest.webmanifest, iOS reads the apple-* tags and ignores the manifest for the icon and
 * title. Missing either one means "add to home screen" produces a bookmark with a screenshot
 * for an icon.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const B = process.env.B || 'http://localhost:8221';
const fails = [];
const note = [];
const ok = (c, m) => { if (!c) fails.push(m); else note.push(m); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

// --- the served files -----------------------------------------------------
for (const [path, test, label] of [
  ['/manifest.webmanifest', (t) => JSON.parse(t).display === 'standalone', 'manifest is served and standalone'],
  ['/sw.js', (t) => /addEventListener\('fetch'/.test(t), 'service worker is served'],
  ['/cardcrop.js', (t) => /export function findCard/.test(t), 'crop module is served'],
  ['/icon-192.png', (t) => t.length > 1000, 'icon is served'],
  ['/apple-touch-icon.png', (t) => t.length > 1000, 'apple touch icon is served'],
]) {
  const r = await ctx.request.get(B + path);
  const body = await r.text();
  ok(r.ok() && test(body), `${label} (${r.status()})`);
}

const man = JSON.parse(await (await ctx.request.get(B + '/manifest.webmanifest')).text());
ok(man.icons.some((i) => i.sizes === '512x512'), 'manifest has a 512px icon (required to install)');
ok(man.icons.some((i) => i.purpose === 'maskable'), 'manifest has a maskable icon, so Android does not letterbox it');
ok(man.start_url && man.name, 'manifest has a name and start_url');

await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

// --- iOS tags, which the manifest does not cover -------------------------
const head = await p.evaluate(() => ({
  appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
  appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
  appleTitle: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
  manifest: !!document.querySelector('link[rel="manifest"]'),
  themeColor: document.querySelector('meta[name="theme-color"]')?.content,
  viewportFit: /viewport-fit=cover/.test(document.querySelector('meta[name="viewport"]')?.content || ''),
}));
ok(head.manifest, 'the page links the manifest');
ok(head.appleIcon, 'the page has an apple-touch-icon (iOS ignores the manifest for this)');
ok(head.appleCapable === 'yes', 'iOS standalone mode is requested');
ok(head.appleTitle === 'CardVault', `iOS home-screen name is set (${head.appleTitle})`);
ok(!!head.themeColor, 'theme colour is set, so the status bar matches the app');
ok(head.viewportFit, 'viewport-fit=cover, so a standalone install can use the full screen');

// --- the crop, driven through the real file input ------------------------
// A synthetic photo: pale card on a dark mat, deliberately offset so a correct crop is
// visibly different from the whole frame.
const photo = await p.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const g = c.getContext('2d');
  g.fillStyle = '#1e1e20'; g.fillRect(0, 0, 900, 1200);
  g.fillStyle = '#e8e2d6'; g.fillRect(180, 260, 400, 560);       // 0.714, card-shaped
  g.fillStyle = '#2f6fb0'; g.fillRect(210, 300, 340, 300);
  return c.toDataURL('image/jpeg', 0.9);
});
const bytes = Buffer.from(photo.split(',')[1], 'base64');

await p.evaluate(() => document.getElementById('openAdd')?.click()
  || document.querySelector('[id*=Add]')?.click());
await p.waitForTimeout(600);

await p.setInputFiles('#adFile', { name: 'card.jpg', mimeType: 'image/jpeg', buffer: bytes });
await p.waitForTimeout(2500);

ok(await p.locator('#cropDlg').isVisible(), 'the crop review dialog opened by itself');
const why = await p.locator('#cropWhy').innerText();
ok(!/not card-shaped|rotated|could not/i.test(why), `the card was found (${why.slice(0, 70)})`);
const boxVisible = await p.locator('#cropBoxEl').isVisible();
ok(boxVisible, 'the proposed crop is drawn on the preview');
const boxRect = await p.locator('#cropBoxEl').boundingBox();
const imgRect = await p.locator('#cropImg').boundingBox();
ok(boxRect && imgRect && boxRect.width < imgRect.width * 0.95,
   'the box is smaller than the photo, i.e. it actually cropped something');
ok(!(await p.locator('#cropUse').isDisabled()), '"use this crop" is available');

await p.locator('#cropUse').click();
await p.waitForTimeout(800);
ok(!(await p.locator('#cropDlg').isVisible()), 'the dialog closes on accept');

const result = await p.evaluate(() => {
  const img = document.getElementById('adPreview');
  return { src: (img?.src || '').slice(0, 30), len: (img?.src || '').length,
           note: document.getElementById('adPreviewNote')?.textContent || '' };
});
ok(/^data:image\/jpeg/.test(result.src), 'the cropped result is a JPEG data URL');
ok(result.len * 0.75 < bytes.length, `the crop is smaller than the original (${
  Math.round(result.len * 0.75 / 1024)} KB vs ${Math.round(bytes.length / 1024)} KB)`);
ok(/cropped/i.test(result.note), `the preview says it was cropped ("${result.note}")`);

// --- a photo it should refuse -------------------------------------------
const pen = await p.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const g = c.getContext('2d');
  g.fillStyle = '#1e1e20'; g.fillRect(0, 0, 900, 1200);
  g.fillStyle = '#e8e2d6'; g.fillRect(80, 560, 740, 90);         // long and thin: not a card
  return c.toDataURL('image/jpeg', 0.9);
});
await p.setInputFiles('#adFile', {
  name: 'pen.jpg', mimeType: 'image/jpeg',
  buffer: Buffer.from(pen.split(',')[1], 'base64'),
});
await p.waitForTimeout(2500);
ok(await p.locator('#cropDlg').isVisible(), 'a doubtful photo still opens the dialog');
ok(await p.locator('#cropUse').isDisabled(),
   'but cropping is disabled — a confidently wrong crop is the failure worth preventing');
ok(/not card-shaped|rotated|could not/i.test(await p.locator('#cropWhy').innerText()),
   'and it says why');
ok(!(await p.locator('#cropWhole').isDisabled()), 'the whole photo is still offered');

console.log(JSON.stringify({ passed: note.length, failed: fails.length, fails,
  pageErrors: errs.slice(0, 3), note }, null, 2));
await b.close();
process.exit(fails.length ? 1 : 0);
