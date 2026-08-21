import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8190';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1500, height: 1080 }, deviceScaleFactor: 1.4 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });
await p.goto(B, { waitUntil: 'networkidle' }); await p.waitForTimeout(1800);

await p.click('#openAdd'); await p.waitForTimeout(700);
const shots = [];
async function snap(label) {
  await p.waitForTimeout(700);
  const src = await p.locator('#adPreview').getAttribute('src');
  const note = await p.locator('#adPreviewNote').innerText();
  shots.push(`${label.padEnd(26)} note="${note}"  src=${(src||'').slice(0,110)}`);
}
// Base
await p.fill('#acSearch', 'Gilberto Mora'); await p.waitForTimeout(1100);
await p.locator('#acResults .pick').first().click(); await snap('picked base');
// Optic — pick the Base Optic version of the same player
await p.fill('#acSearch', 'Gilberto Mora'); await p.waitForTimeout(1100);
const picks = await p.locator('#acResults .pick').count();
for (let i = 0; i < picks; i++) {
  const t = await p.locator('#acResults .pick').nth(i).innerText();
  if (/Optic/i.test(t)) { await p.locator('#acResults .pick').nth(i).click(); break; }
}
await snap('picked Base Optic');
await p.screenshot({ path: '/tmp/shots/art-optic.png' });
// a gold parallel
await p.fill('#adParallel', 'Gold (#/10)'); await snap('+ Gold /10');
await p.screenshot({ path: '/tmp/shots/art-gold.png' });
// graded
await p.selectOption('#adGrader', 'PSA'); await p.selectOption('#adGrade', '10'); await snap('+ PSA 10 slab');
await p.screenshot({ path: '/tmp/shots/art-graded.png' });
// Kaboom
await p.fill('#adParallel', ''); await p.selectOption('#adGrader', ''); await p.selectOption('#adGrade', '');
await p.fill('#acSearch', 'Messi'); await p.waitForTimeout(1100);
const n2 = await p.locator('#acResults .pick').count();
for (let i = 0; i < n2; i++) {
  const t = await p.locator('#acResults .pick').nth(i).innerText();
  if (/Kaboom!/.test(t) && !/Oversize/.test(t)) { await p.locator('#acResults .pick').nth(i).click(); break; }
}
await snap('picked Kaboom!');
await p.screenshot({ path: '/tmp/shots/art-kaboom.png' });

console.log(shots.join('\n'));
const uniq = new Set(shots.map((s) => s.split('src=')[1]));
console.log('\ndistinct artwork URLs:', uniq.size, 'of', shots.length);
console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
await b.close();
