/** The three new surfaces: launcher in the detail panel, regions and geo on Insights. */
import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8213';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });

await p.goto(B, { waitUntil: 'networkidle' });
await p.click('#modeSeg button[data-k="cards"]');
await p.waitForTimeout(1500);
await p.locator('.card').first().click();
await p.waitForTimeout(2200);

const look = await p.locator('#lookBlock').innerText();
console.log('launcher headings:', /Where it sells, measured/.test(look), /Go and look/.test(look));
const links = await p.locator('#lookBlock a').evaluateAll((els) => els.map((e) => ({
  label: (e.textContent || '').trim().slice(0, 34), href: e.getAttribute('href') || '',
  target: e.getAttribute('target'), rel: e.getAttribute('rel'),
})));
console.log('links rendered:', links.length);
console.log('all open in a new tab with noopener:',
  links.every((l) => l.target === '_blank' && /noopener/.test(l.rel || '')));
console.log('sample:', links.slice(0, 3).map((l) => l.label).join(' | '));
console.log('every href absolute https:', links.every((l) => /^https:\/\//.test(l.href)));
await p.locator('dialog#dlg .dlg > div').first().screenshot({ path: '/tmp/shots/geo-look.png' });
await p.click('#dlgX');
await p.waitForTimeout(400);

await p.click('nav button[data-t="insights"]');
await p.waitForTimeout(2000);
const reg = await p.locator('#regionPanel').innerText();
const geo = await p.locator('#geoPanel').innerText();
console.log('regions panel:', reg.replace(/\n+/g, ' | ').slice(0, 150));
console.log('geo panel:', geo.replace(/\n+/g, ' | ').slice(0, 150));
await p.locator('#regionPanel').screenshot({ path: '/tmp/shots/geo-regions.png' });
console.log('ERRORS:', errs.length ? errs.slice(0, 4) : 'none');
await b.close();
