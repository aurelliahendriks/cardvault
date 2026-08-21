/** Position and club as filters: API, then the UI that drives them. */
import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8183';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });
await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1800);

const opts = async (id) => (await p.locator(`#${id} option`).allInnerTexts());
/** Playwright wants an exact label, and these carry counts — match on substring. */
const pick = async (id, needle) => {
  const value = await p.locator(`#${id}`).evaluate((sel, n) => {
    const o = [...sel.options].find((x) => x.textContent.toLowerCase().includes(n.toLowerCase()));
    return o ? o.value : null;
  }, needle);
  if (value == null) throw new Error(`no option matching ${needle} in #${id}`);
  await p.selectOption(`#${id}`, value);
};
console.log('position options:', (await opts('gPos')).join(' | '));
console.log('club options:', (await opts('gClub')).slice(0, 8).join(' | '), '…');

// Player grid, filtered by club.
await pick('gClub', 'Real Madrid');
await p.waitForTimeout(1400);
console.log('players at Real Madrid:', (await p.locator('.pcard .fnm').allInnerTexts()).join(', '));
console.log('tile subtitle:', (await p.locator('.pcard .ftm').first().innerText()));

// Same filter in every-card mode.
await p.click('#modeSeg button[data-k="cards"]');
await p.waitForTimeout(1400);
console.log('cards at Real Madrid:', await p.locator('.card').count(), '·', (await p.locator('#galMeta').innerText()).slice(0, 60));

// Position, on its own.
await p.selectOption('#gClub', '');
await pick('gPos', 'Goalkeeper');
await p.waitForTimeout(1400);
console.log('cards for goalkeepers:', await p.locator('.card').count());
await pick('gPos', 'unknown');
await p.waitForTimeout(1400);
console.log('cards with no position on file:', await p.locator('.card').count());

// Combined with a nation, which is the case that breaks naive filter code.
await p.selectOption('#gPos', '');
await pick('gTeam', 'Argentina');
await pick('gClub', 'Inter Miami');
await p.waitForTimeout(1400);
console.log('Argentina + Inter Miami:', await p.locator('.card').count(), 'cards');
await p.screenshot({ path: '/tmp/shots/facets.png' });
console.log('ERRORS:', errs.length ? errs.slice(0, 4) : 'none');
await b.close();
