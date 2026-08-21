/**
 * Two questions a still screenshot cannot answer on its own:
 *   1. do tiles for different players actually differ?
 *   2. does the motion actually move — and does it stop when asked?
 *
 * Answered by capturing the same page twice, ~700ms apart, and comparing pixels.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const B = process.env.B || 'http://localhost:8203';
const NAMES = process.env.NAMES
  ? process.env.NAMES.split('|')
  : ['Lionel Messi', 'Lamine Yamal', 'Cristiano Ronaldo', 'Kylian Mbappe',
     'Erling Haaland', 'Gilberto Mora', 'Jude Bellingham', 'Bukayo Saka',
     'Virgil van Dijk', 'Thibaut Courtois', 'Pedri', 'Rodri'];

const page = (names, anim) => `<html><body style="margin:0;background:#141413;display:grid;
  grid-template-columns:repeat(6,132px);gap:8px;padding:8px">
  ${names.map((n) => `<img width="132" height="132" src="${B}/api/img/player/${encodeURIComponent(n)}${anim ? '' : '?anim=0'}">`).join('')}
</body></html>`;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

async function shots({ anim, reduced, hint, out }) {
  const p = await b.newPage({
    viewport: { width: 840, height: 300 },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    // The client hint is how a browser tells the server, which is the channel that
    // actually works for an <img>-loaded SVG.
    extraHTTPHeaders: hint ? { 'Sec-CH-Prefers-Reduced-Motion': 'reduce' } : {},
  });
  await p.setContent(page(NAMES, anim), { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  const a = await p.screenshot({ path: out ? out + '-a.png' : undefined });
  await p.waitForTimeout(750);
  const c = await p.screenshot({ path: out ? out + '-b.png' : undefined });
  await p.close();
  const h = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 10);
  return { same: h(a) === h(c), ha: h(a), hb: h(c) };
}

const motion = await shots({ anim: true, reduced: false, out: '/tmp/shots/avatars-motion' });
console.log('animated: frames differ over 750ms:', motion.same === false, `(${motion.ha} vs ${motion.hb})`);

const off = await shots({ anim: false, reduced: false });
console.log('anim=0: frames identical:', off.same === true);

const hinted = await shots({ anim: true, reduced: true, hint: true });
console.log('Sec-CH-Prefers-Reduced-Motion: frames identical:', hinted.same === true);

// And the dashboard's own path: it reads matchMedia and appends ?anim=0 itself.
const p3 = await b.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
await p3.goto(B, { waitUntil: 'networkidle' });
await p3.waitForTimeout(1800);
const srcs = await p3.locator('.pcard img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
console.log('dashboard adds anim=0 under reduced motion:',
  srcs.length > 0 && srcs.every((s) => /anim=0/.test(s || '')), `(${srcs.length} tiles)`);
await p3.close();

// Do the tiles differ from each other? Compare each avatar's own bytes.
const p2 = await b.newPage({ viewport: { width: 840, height: 300 } });
const bodies = [];
for (const n of NAMES) {
  const r = await p2.request.get(`${B}/api/img/player/${encodeURIComponent(n)}?anim=0`);
  bodies.push(await r.text());
}
const uniq = new Set(bodies.map((s) => createHash('sha1').update(s).digest('hex')));
console.log(`distinct avatar documents: ${uniq.size}/${NAMES.length}`);
// And a coarse visual check: strip ids and colours, compare the remaining structure.
const shape = bodies.map((s) => s.replace(/v[0-9a-f]{8}|p[0-9a-f]{8}|#[0-9a-f]{3,6}/g, ''));
console.log(`distinct structures (ids and colours ignored): ${new Set(shape).size}/${NAMES.length}`);
await p2.close();
await b.close();
