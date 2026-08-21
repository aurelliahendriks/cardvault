import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8181';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1560, height: 1180 }, deviceScaleFactor: 1.4 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });

await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1800);

// player grid: the poses
console.log('player tiles:', await p.locator('.pcard').count());
await p.screenshot({ path: '/tmp/shots/fx-players.png' });

// every-card mode: the rarity tiers
await p.click('#modeSeg button[data-k="cards"]');
await p.waitForTimeout(1600);
const tiers = {};
for (const t of ['base', 'silver', 'gold', 'shimmer', 'ice', 'foil', 'unique']) {
  tiers[t] = await p.locator(`.card.tier-${t}`).count();
}
console.log('tier counts:', JSON.stringify(tiers));
console.log('fx overlays:', await p.locator('.card .fx').count());
await p.screenshot({ path: '/tmp/shots/fx-gallery.png' });

// the effects toggle
await p.click('#fxToggle');
await p.waitForTimeout(300);
console.log('toggle text:', await p.locator('#fxToggle').innerText());
console.log('fx hidden when off:', await p.locator('.card .fx').first().isVisible() === false);
await p.click('#fxToggle');
await p.waitForTimeout(200);

// the ladder on the data tab
await p.click('nav button[data-t="data"]');
await p.waitForTimeout(1500);
console.log('ladder samples:', await p.locator('#fxLadder .pcard').count());
console.log('ladder labels:', (await p.locator('#fxLadder .nm').allInnerTexts()).join(' | '));
await p.locator('#fxLadder').scrollIntoViewIfNeeded();
await p.waitForTimeout(600);
await p.locator('#fxLadder').screenshot({ path: '/tmp/shots/fx-ladder.png' });

console.log('\nERRORS:', errs.length ? errs.slice(0, 6) : 'none');
await b.close();
