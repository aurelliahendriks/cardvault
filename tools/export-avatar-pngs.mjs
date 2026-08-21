/**
 * Rasterise the SVG pack to PNG.
 *
 * Screenshotting 783 elements one at a time is minutes of round-trips, so this lays them
 * out in exact 256px cells with no gaps, screenshots the page, and slices the grid with
 * PIL. Deterministic because the layout is fixed rather than flowed.
 */
import { chromium } from 'playwright';
import { readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PACK = process.argv[2] ?? '/tmp/player-pack';
const CELL = 256, COLS = 10, PER_PAGE = 100;
const files = readdirSync(join(PACK, 'svg')).filter((f) => f.endsWith('.svg')).sort();
mkdirSync(join(PACK, 'png'), { recursive: true });
mkdirSync('/tmp/pack-sheets', { recursive: true });

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const manifest = [];
for (let page = 0; page * PER_PAGE < files.length; page++) {
  const batch = files.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const rows = Math.ceil(batch.length / COLS);
  const p = await b.newPage({ viewport: { width: CELL * COLS, height: CELL * rows } });
  // setContent's baseURL does not resolve relative <img src>, so the first version
  // screenshotted 800 empty cells. Write the sheet into the pack directory and navigate
  // to it, so the relative paths resolve the way they would in a browser.
  const sheetHtml = join(PACK, `.sheet-${page}.html`);
  writeFileSync(sheetHtml,
    `<style>html,body{margin:0;background:#000}#g{display:grid;
       grid-template-columns:repeat(${COLS},${CELL}px);grid-auto-rows:${CELL}px}
     img{width:${CELL}px;height:${CELL}px;display:block}</style>
     <div id="g">${batch.map((f) => `<img src="svg/${encodeURIComponent(f)}">`).join('')}</div>`);
  await p.goto('file://' + sheetHtml, { waitUntil: 'load' });
  // The <img> elements load from disk; wait for all of them rather than a timeout.
  await p.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 60_000 });
  await p.waitForTimeout(250);
  const sheet = `/tmp/pack-sheets/sheet-${page}.png`;
  await p.screenshot({ path: sheet });
  await p.close();
  unlinkSync(sheetHtml);
  manifest.push({ sheet, batch, rows });
  process.stdout.write(`  sheet ${page + 1}: ${batch.length} avatars\n`);
}
await b.close();
writeFileSync('/tmp/pack-sheets/manifest.json', JSON.stringify({ cell: CELL, cols: COLS, manifest }));
console.log(`${files.length} avatars across ${manifest.length} sheets`);
