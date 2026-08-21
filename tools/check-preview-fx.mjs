import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1.35 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await p.goto('file:///home/claude/cardvault/cardvault-preview.html', { waitUntil: 'load' });
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/shots/pv-players.png' });
await p.click('#modeSeg button[data-k="cards"]'); await p.waitForTimeout(1500);
const t = {};
for (const k of ['base','silver','gold','scarce','scarcer','ice','foil','elite','unique']) t[k] = await p.locator(`.card.tier-${k}`).count();
console.log('tiers:', JSON.stringify(t), 'fx:', await p.locator('.card .fx').count());
await p.screenshot({ path: '/tmp/shots/pv-cards.png' });
await p.click('nav button[data-t="data"]'); await p.waitForTimeout(1400);
console.log('ladder:', await p.locator('#fxLadder .pcard').count());
await p.locator('#fxLadder').scrollIntoViewIfNeeded(); await p.waitForTimeout(500);
await p.locator('#fxLadder').screenshot({ path: '/tmp/shots/pv-ladder.png' });
// the two new filters, offline
await p.click('nav button[data-t="gallery"]'); await p.waitForTimeout(900);
const pickOpt = async (id, needle) => {
  const v = await p.locator(`#${id}`).evaluate((sel, n) => {
    const o = [...sel.options].find((x) => x.textContent.toLowerCase().includes(n.toLowerCase()));
    return o ? o.value : null;
  }, needle);
  if (v == null) return null;
  await p.selectOption(`#${id}`, v); await p.waitForTimeout(900);
  return v;
};
console.log('position options:', await p.locator('#gPos option').count(),
            '| club options:', await p.locator('#gClub option').count());
await pickOpt('gClub', 'Real Madrid');
// Scoped to #pgal: the ladder samples on the data tab are .pcard too and stay in the
// DOM, so an unscoped count silently includes them.
console.log('players filtered to Real Madrid:', await p.locator('#pgal .pcard').count());
await p.click('#modeSeg button[data-k="cards"]'); await p.waitForTimeout(1100);
console.log('cards filtered to Real Madrid:', await p.locator('.card').count());
console.log('ERRORS:', errs.length ? errs.slice(0,4) : 'none');
await b.close();
