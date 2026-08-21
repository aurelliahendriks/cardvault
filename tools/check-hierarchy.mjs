/**
 * Capture the rarity ladder for measurement.
 *
 * Animations are frozen deterministically rather than left running: a sweep caught at
 * a random phase makes any measurement noise, and "is /99 stronger than /199" is not a
 * question you can answer from one lucky frame. A negative animation-delay plus
 * paused play-state parks every effect at the same point in its cycle every run.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const B = process.env.B || 'http://localhost:8181';
const OUT = process.env.OUT || '/tmp/shots/hier';
const SIZE = process.env.SIZE || 'm';          // m = gallery default, s = smallest grid
const MODE = process.env.MODE || 'motion';     // motion | reduced | off | graded

mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({
  viewport: { width: 1560, height: 1200 },
  deviceScaleFactor: 1,
  reducedMotion: MODE === 'reduced' ? 'reduce' : 'no-preference',
});
// Ask the ladder for a graded twin of every rung, so grade × rung can be measured.
if (MODE === 'graded') await p.addInitScript(() => { window.__FX_GRADED = true; });
await p.goto(B, { waitUntil: 'networkidle' });
// The toggle lives on the gallery toolbar, so it has to be flipped before leaving
// that tab — it is display:none once another section is showing.
if (MODE === 'off') { await p.click('#fxToggle'); await p.waitForTimeout(200); }
await p.click('nav button[data-t="data"]');
await p.waitForTimeout(1500);

// Freeze at a fixed phase, ~40% into a 2.8s cycle — inside the sweep, not at its edge.
await p.addStyleTag({ content: `*,*::before,*::after{
  animation-play-state:paused!important; animation-delay:-1.15s!important;
  transition:none!important }` });

// Force a known tile width so every step is measured at the same scale.
const width = SIZE === 's' ? 132 : 186;
const cols = MODE === 'graded' ? 20 : 10;
await p.locator('#fxLadder').evaluate((el, o) => {
  el.style.display = 'grid';
  el.style.gridTemplateColumns = `repeat(${o.cols}, ${o.w}px)`;
  el.style.gap = '10px';
  el.style.width = `${o.w * o.cols + 100}px`;
}, { w: width, cols });
await p.waitForTimeout(700);

const tiles = p.locator('#fxLadder article');
const n = await tiles.count();
const rows = [];
for (let i = 0; i < n; i++) {
  const t = tiles.nth(i);
  const meta = await t.evaluate((el) => ({
    tier: el.dataset.tier, step: el.dataset.step, rank: Number(el.dataset.rank),
  }));
  const file = `${OUT}/${String(i).padStart(2, '0')}-${meta.tier}` +
    `${/PSA 10$/.test(meta.step) ? '-graded' : ''}.png`;
  // The .shot only: the caption underneath is text, and text would dominate every
  // edge measurement and drown the effect being tested.
  await t.locator('.shot').screenshot({ path: file });
  rows.push({ ...meta, file });
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ size: SIZE, mode: MODE, rows }, null, 2));
console.log(`captured ${rows.length} steps  size=${SIZE} mode=${MODE}`);
await b.close();
