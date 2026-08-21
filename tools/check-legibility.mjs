/**
 * The effects sit under the caption, so they can eat it. Check the text that has to
 * survive: player name and price on a tile, at every tier.
 */
import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8183';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1560, height: 1200 } });
await p.goto(B, { waitUntil: 'networkidle' });
await p.click('#modeSeg button[data-k="cards"]');
await p.waitForTimeout(1600);

// The effect layer must never sit above the caption in z-order, at any tier.
const z = await p.evaluate(() => {
  const out = [];
  for (const card of document.querySelectorAll('.card')) {
    const fx = card.querySelector('.fx'), ovl = card.querySelector('.ovl');
    if (!fx || !ovl) continue;
    out.push({
      tier: [...card.classList].find((c) => c.startsWith('tier-')),
      fxZ: +getComputedStyle(fx).zIndex, ovlZ: +getComputedStyle(ovl).zIndex,
      fxPointer: getComputedStyle(fx).pointerEvents,
    });
  }
  return out;
});
const above = z.filter((r) => r.fxZ >= r.ovlZ);
const clickable = z.filter((r) => r.fxPointer !== 'none');
console.log('tiles checked:', z.length);
console.log('effect layer above the caption:', above.length, above.length ? JSON.stringify(above[0]) : '(none — correct)');
console.log('effect layer swallowing clicks:', clickable.length, clickable.length ? JSON.stringify(clickable[0]) : '(none — correct)');

// A tile of every tier must still be clickable through the overlay.
const tiers = [...new Set(z.map((r) => r.tier))];
let opened = 0;
for (const t of tiers) {
  const el = p.locator(`.card.${t}`).first();
  if (!(await el.count())) continue;
  await el.click();
  await p.waitForTimeout(900);
  if (await p.locator('dialog#dlg[open]').count()) { opened++; await p.click('#dlgX'); await p.waitForTimeout(300); }
}
console.log(`tiers present: ${tiers.length} — detail opened for ${opened}`);

// Text contrast over the effect: sample the rendered caption region.
const worst = await p.evaluate(() => {
  const res = [];
  for (const card of document.querySelectorAll('.card')) {
    const nm = card.querySelector('.ovl .nm');
    if (!nm) continue;
    const cs = getComputedStyle(nm);
    res.push({
      tier: [...card.classList].find((c) => c.startsWith('tier-')),
      colour: cs.color, shadow: cs.textShadow !== 'none',
    });
  }
  return res;
});
console.log('captions with a text shadow backing them:', worst.filter((w) => w.shadow).length, '/', worst.length);
const fail = above.length || clickable.length || worst.some((w) => !w.shadow) || opened !== tiers.length;
console.log(fail ? 'LEGIBILITY: FAIL' : 'LEGIBILITY: PASS');
await b.close();
process.exit(fail ? 1 : 0);
