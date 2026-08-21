import { chromium } from 'playwright';
const B = process.env.B || 'http://localhost:8175';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1500, height: 1150 }, deviceScaleFactor: 1.4 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });
await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);

// --- add dialog, checklist path -------------------------------------------
await p.click('#openAdd'); await p.waitForTimeout(700);
console.log('dialog open:', await p.locator('#addDlg[open]').count());
await p.fill('#acSearch', 'Yamal'); await p.waitForTimeout(1200);
const hits = await p.locator('#acResults .pick').count();
console.log('search "Yamal" results:', hits);
await p.locator('#acResults .pick').first().click(); await p.waitForTimeout(900);
console.log('picked line:', (await p.locator('#acPicked').innerText()).slice(0, 90));
const parOpts = await p.locator('#parList option').count();
console.log('parallel suggestions for that section:', parOpts);
await p.fill('#adQty', '3'); await p.fill('#adCost', '4.20');
await p.selectOption('#adBox', { index: 3 });
await p.fill('#adFrom', 'blaster from Big W');
await p.screenshot({ path: '/tmp/shots/add-checklist.png' });
await p.click('#addSave'); await p.waitForTimeout(2000);
console.log('dialog closed after save:', (await p.locator('#addDlg[open]').count()) === 0);

// --- custom path ----------------------------------------------------------
await p.click('#openAdd'); await p.waitForTimeout(600);
await p.click('#addMode button[data-m="custom"]'); await p.waitForTimeout(400);
await p.fill('#cuPlayer', 'Kylian Mbappe');
await p.fill('#cuTeam', 'France');
await p.fill('#cuSet', 'Topps Chrome UCL');
await p.fill('#cuYear', '2025-26');
await p.fill('#cuSection', 'Refractor');
await p.fill('#cuNum', '12');
await p.fill('#cuEst', '140');
await p.check('#cuAuto');
await p.fill('#adParallel', 'Gold Wave /50');
await p.fill('#adQty', '1'); await p.fill('#adCost', '110');
await p.screenshot({ path: '/tmp/shots/add-custom.png' });
await p.click('#addSave'); await p.waitForTimeout(2200);
console.log('custom saved, dialog closed:', (await p.locator('#addDlg[open]').count()) === 0);

// --- verify it shows up with type + box -----------------------------------
await p.click('#viewSeg button[data-v="owned"]'); await p.waitForTimeout(1500);
const tiles = await p.locator('.card').count();
console.log('owned tiles now:', tiles);
const texts = await p.locator('.card .ovl').allInnerTexts();
console.log('a tile caption:', JSON.stringify(texts.find((t) => /Mbappe/i.test(t)) || texts[0]));
await p.screenshot({ path: '/tmp/shots/add-gallery.png' });

// --- detail panel: type + box blocks --------------------------------------
await p.locator('.card').first().click(); await p.waitForTimeout(2000);
const heads = await p.locator('dialog#dlg h2').allInnerTexts();
console.log('detail panels:', heads.slice(0, 6));
await p.screenshot({ path: '/tmp/shots/add-detail.png' });

// --- insights new charts --------------------------------------------------
await p.click('#dlgX'); await p.waitForTimeout(400);
await p.click('nav button[data-t="insights"]'); await p.waitForTimeout(2200);
console.log('type chart bars:', await p.locator('#cType .brow').count(),
            '| box chart bars:', await p.locator('#cBox .brow').count());
await p.screenshot({ path: '/tmp/shots/add-insights.png', fullPage: true });

console.log('\nERRORS:', errs.length ? errs.slice(0, 6) : 'none');
await b.close();
