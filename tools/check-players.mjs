import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8195';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1560, height: 1120 }, deviceScaleFactor: 1.4 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });

await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(2200);

// --- player grid is the default -------------------------------------------
console.log('mode buttons:', await p.locator('#modeSeg button').count());
console.log('players mode active:', await p.locator('#modeSeg button[data-k="players"].on').count() === 1);
const ptiles = await p.locator('.pcard').count();
console.log('player tiles:', ptiles);
console.log('meta:', (await p.locator('#galMeta').innerText()).slice(0, 130));
await p.screenshot({ path: '/tmp/shots/players-grid.png' });

// one tile should aggregate multiple versions
const caps = await p.locator('.pcard').allInnerTexts();
console.log('a tile:', JSON.stringify((caps.find((c) => /Yamal/.test(c)) || caps[0] || '').replace(/\n/g, ' | ')));

// --- open a player --------------------------------------------------------
const yamal = p.locator('.pcard', { hasText: 'Yamal' }).first();
await (await yamal.count() ? yamal : p.locator('.pcard').first()).click();
await p.waitForTimeout(2000);
const heads = await p.locator('#pPage h1, #pPage h2').allInnerTexts();
console.log('player page sections:', heads);
console.log('owned rows:', await p.locator('#pPage .crow').count());
console.log('missing tiles:', await p.locator('#pPage .card').count());
console.log('stat tiles:', await p.locator('#pPage .tile').count());
await p.screenshot({ path: '/tmp/shots/player-page.png', fullPage: true });

// --- a card row opens the full card detail --------------------------------
if (await p.locator('#pPage .crow').count()) {
  await p.locator('#pPage .crow').first().click();
  await p.waitForTimeout(1800);
  console.log('card detail opened:', await p.locator('dialog#dlg[open]').count() === 1);
  console.log('detail panels:', (await p.locator('dialog#dlg h2').allInnerTexts()).slice(0, 3));
  await p.click('#dlgX'); await p.waitForTimeout(400);
}

// --- back, and switch to every-card mode ----------------------------------
await p.click('#pBack'); await p.waitForTimeout(1200);
await p.click('#modeSeg button[data-k="cards"]'); await p.waitForTimeout(1500);
console.log('card tiles after switching:', await p.locator('.card').count());
console.log('player grid hidden:', await p.locator('#pgal[hidden]').count() === 1);

console.log('\nERRORS:', errs.length ? errs.slice(0, 6) : 'none');
await b.close();
