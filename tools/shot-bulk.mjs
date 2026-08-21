/**
 * Screenshot the bulk-add dialog as somebody actually uses it.
 *
 * Not a test — `check-bulk.mjs` is the test. This exists so the review step can be looked
 * at and argued with before it ships, which for a screen whose whole job is "make a wrong
 * match obvious" is the only review that means anything.
 *
 * Stops before committing. Nothing here writes.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const B = process.env.B || 'http://localhost:8217';
const OUT = process.env.OUT || '/tmp/shots';
mkdirSync(OUT, { recursive: true });

const LINES = [
  'mora 214 x2 @4.50',
  'messi kaboom psa 10',
  '#91 ronaldo teal',
  'yamal base blue /49',
  'mbappe 145 x3 @18',
  'bellingham kaboom psa 9 @26.50',
  'vini jr 179 gold /10',
  'total nonsense zzzz',
];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1180, height: 1180 }, deviceScaleFactor: 2 });
await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

await p.click('#openBulk');
await p.waitForTimeout(400);
const dialog = p.locator('dialog:has(#bulkText)');

// 1. Empty, so the placeholder and the instructions are legible on their own.
await dialog.screenshot({ path: `${OUT}/bulk-1-empty.png` });

// 2. Typed but not checked.
await p.fill('#bulkText', LINES.join('\n'));
await dialog.screenshot({ path: `${OUT}/bulk-2-typed.png` });

// 3. Reviewed. The important one.
await p.click('#bulkParse');
await p.waitForTimeout(6000);
await dialog.screenshot({ path: `${OUT}/bulk-3-reviewed.png` });

// 4. The off-checklist parallel, picked — the state that creates a SKU.
const pickers = p.locator('#bulkResult [data-card]');
const n = await pickers.count();
for (let i = 0; i < n; i++) await pickers.nth(i).selectOption({ index: 1 });
await p.waitForTimeout(300);
await dialog.screenshot({ path: `${OUT}/bulk-4-picked.png` });
await p.locator('#bulkResult').screenshot({ path: `${OUT}/bulk-5-table.png` });

console.log(JSON.stringify({
  pickers: n,
  summary: (await p.locator('#bulkResult .muted').first().innerText()).replace(/\s+/g, ' '),
  button: (await p.locator('#bulkCommit').innerText()).trim(),
  statuses: (await p.locator('#bulkResult tbody tr td:first-child').allInnerTexts())
    .map((s) => s.trim()),
}, null, 2));

await b.close();
