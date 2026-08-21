import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1150 }, deviceScaleFactor: 1.5 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await p.goto('http://localhost:8155/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
const tabs = [['gallery','Gallery'],['board','Actions'],['insights','Insights'],['venues','Where to sell']];
for (const [k, label] of tabs) {
  await p.click(`nav button[data-t="${k}"]`);
  await p.waitForTimeout(k === 'venues' ? 500 : 1800);
  if (k === 'venues') { await p.click('#vGo'); await p.waitForTimeout(1500); }
  await p.screenshot({ path: `${process.env.SHOT_DIR ?? '/tmp/shots'}/${k}.png`, fullPage: k !== 'gallery' });
  console.log('shot', k);
}
console.log('CONSOLE ERRORS:', errs.length ? JSON.stringify(errs.slice(0, 12), null, 1) : 'none');
await b.close();
