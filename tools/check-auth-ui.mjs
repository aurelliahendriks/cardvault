/**
 * With ADMIN_API_KEY set, can the UI still write?
 *
 * Regression test for a shipped bug: the server guards every non-GET with `x-api-key`, and
 * the page never sent it, so with a key configured *every* write from the browser failed with
 * `{"error":"x-api-key required"}` — adding a card, pinning a photo, bulk add. The guard and
 * the client were built at different times and nothing checked that they agreed.
 *
 * Run against a server started WITH ADMIN_API_KEY. Asserts, in order:
 *   1. reads work with no key at all (the guard is on writes only);
 *   2. a raw write with no key is refused (the guard actually works);
 *   3. the page asks for the key on load, because being told after a long paste is the same
 *      as losing the paste;
 *   4. once given, a real write through the UI succeeds;
 *   5. the key survives a reload, so it is asked for once and not every visit.
 */
import { chromium } from 'playwright';

const B = process.env.B || 'http://localhost:8218';
const KEY = process.env.KEY || 'test-key';
const fails = [];
const note = [];

// 1 + 2: the guard, without a browser involved.
const health = await (await fetch(`${B}/api/health`)).json();
if (!health.ok) fails.push('reads should work with no key');
if (health.authRequired !== true) fails.push('/api/health must advertise authRequired');

const naked = await fetch(`${B}/api/collection/parse`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'mora 214' }),
});
if (naked.status !== 401) fails.push(`unauthenticated write returned ${naked.status}, expected 401`);

const withKey = await fetch(`${B}/api/collection/parse`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
  body: JSON.stringify({ text: 'mora 214' }),
});
if (!withKey.ok) fails.push(`write with the key returned ${withKey.status}`);

// 3-5: the browser.
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1300, height: 950 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

const dlgOpen = await p.evaluate(() => document.getElementById('keyDlg')?.open === true);
if (!dlgOpen) fails.push('the key dialog did not open on load with a key configured');
else note.push('key dialog opened on load');

await p.fill('#keyInput', KEY);
await p.click('#keySave');
await p.waitForTimeout(500);

// A real write through the real UI.
await p.click('#openBulk');
await p.waitForTimeout(400);
await p.fill('#bulkText', 'mora 214 x2 @4.50');
await p.click('#bulkParse');
await p.waitForTimeout(5000);
const parsedOk = await p.locator('#bulkResult tbody tr').count();
if (parsedOk !== 1) fails.push(`parse through the UI rendered ${parsedOk} rows, expected 1`);

const before = (await (await p.request.get(B + '/api/portfolio')).json()).totals?.lines ?? 0;
await p.click('#bulkCommit');
await p.waitForTimeout(5000);
const after = (await (await p.request.get(B + '/api/portfolio')).json()).totals?.lines ?? 0;
if (after <= before) {
  fails.push(`commit through the UI wrote nothing (${before} -> ${after}) — the key is not reaching writes`);
} else note.push(`commit wrote: ${before} -> ${after} holdings`);

const shown = (await p.locator('#bulkResult').innerText()).replace(/\s+/g, ' ');
if (/x-api-key/i.test(shown)) fails.push('the UI still surfaced an x-api-key error: ' + shown.slice(0, 120));

// 5: remembered across a reload.
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
if (await p.evaluate(() => document.getElementById('keyDlg')?.open === true)) {
  fails.push('the key was not remembered — asked again after reload');
} else note.push('key remembered across reload');

console.log(JSON.stringify({ note, errs, fails }, null, 2));
await b.close();
process.exit(fails.length ? 1 : 0);
