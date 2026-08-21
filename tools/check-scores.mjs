/** The three meters, in the card detail panel. */
import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8185';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1150 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });
await p.goto(B, { waitUntil: 'networkidle' });
await p.click('#modeSeg button[data-k="cards"]');
await p.waitForTimeout(1600);

// A graded scarce card, so all three axes have something to say.
const cards = p.locator('.card');
const n = await cards.count();
let opened = 0;
for (let i = 0; i < Math.min(n, 6); i++) {
  await cards.nth(i).click();
  await p.waitForTimeout(1200);
  const txt = await p.locator('dialog#dlg').innerText();
  const meters = await p.locator('dialog#dlg .num').allInnerTexts();
  const scores = meters.filter((t) => /\/100|not assessed/.test(t)).map((t) => t.trim());
  const title = (txt.split('\n')[0] || '').slice(0, 44);
  console.log(`  ${title.padEnd(46)} ${scores.join('  ')}`);
  opened++;
  await p.click('#dlgX');
  await p.waitForTimeout(300);
}
console.log(`opened ${opened} detail panels`);
await cards.first().click();
await p.waitForTimeout(1400);
// Shoot the left column of the dialog, which is where the meters live.
await p.locator('dialog#dlg .dlg > div').first().screenshot({ path: '/tmp/shots/scores.png' });
console.log('ERRORS:', errs.length ? errs.slice(0, 4) : 'none');
await b.close();
