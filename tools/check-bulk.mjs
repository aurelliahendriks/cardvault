/** Bulk add: paste, review, commit. */
import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8217';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1500, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });

await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
await p.click('#openBulk');
await p.waitForTimeout(400);
await p.fill('#bulkText', [
  'mora 214 x2 @4.50',
  'messi kaboom psa 10',
  'yamal base blue /49',
  'total nonsense zzzz',
].join('\n'));
await p.click('#bulkParse');
await p.waitForTimeout(4000);

const summary = await p.locator('#bulkResult .muted').first().innerText();
console.log('summary:', summary.replace(/\n+/g, ' | ').slice(0, 160));
const rows = await p.locator('#bulkResult tbody tr').count();
console.log('rows rendered:', rows);
const statuses = await p.locator('#bulkResult tbody tr td:first-child').allInnerTexts();
console.log('statuses:', statuses.map((s) => s.trim()).join(' | '));
console.log('dropdowns for alternatives:', await p.locator('#bulkResult [data-alt]').count());
const pickers = p.locator('#bulkResult [data-card]');
console.log('card pickers (off-checklist parallels):', await pickers.count());
console.log('commit button:', (await p.locator('#bulkCommit').innerText()).trim());
await p.locator('#bulkResult').screenshot({ path: '/tmp/shots/bulk.png' });

// A picker must start blank — choosing creates a SKU, so it cannot be a default.
if (await pickers.count()) {
  console.log('picker starts blank:', (await pickers.first().inputValue()) === '');
  console.log('parallel warning:', (await p.locator('#bulkResult td:has([data-card])').first()
    .innerText()).replace(/\n+/g, ' ').slice(0, 120));
  await pickers.first().selectOption({ index: 1 });
  await p.waitForTimeout(200);
  console.log('button after picking:', (await p.locator('#bulkCommit').innerText()).trim());
}

// Nothing may be written before the button is pressed.
const before = await (await p.request.get(B + '/api/portfolio')).json();
console.log('holdings before commit:', before.totals?.lines ?? 0);
await p.click('#bulkCommit');
await p.waitForTimeout(4500);
console.log('result:', (await p.locator('#bulkResult').innerText()).replace(/\n+/g, ' ').slice(0, 120));
const after = await (await p.request.get(B + '/api/portfolio')).json();
console.log('holdings after commit:', after.totals?.lines ?? 0);
console.log('ERRORS:', errs.length ? errs.slice(0, 4) : 'none');
await b.close();
