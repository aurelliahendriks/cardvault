/**
 * Quick add, in a real browser, at phone size.
 *
 * This is the interaction the whole app is judged on: pick the set once, then number-Enter,
 * number-Enter, forty times. So the things asserted here are the things that break that
 * rhythm rather than the things that break the feature:
 *
 *   * does Enter add the card, or does something else eat the key
 *   * does focus come BACK to the number box, or must you click between every card
 *   * does the box clear itself
 *   * does a wrong number say what the right ones would have been
 *   * does typing the same number twice log a duplicate rather than a second row
 *   * is the card you just typed still on screen with its camera buttons
 *   * does the set and section survive a reload
 *
 * Needs a running API and DATABASE_URL.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { mkdirSync } from 'node:fs';

const B = process.env.B || 'http://localhost:8227';
const OUT = process.env.OUT || '/tmp/qa-ui';
mkdirSync(OUT, { recursive: true });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fails = [];
const note = [];
const ok = (c, m) => { if (!c) fails.push(m); else note.push(m); };

const { createUser, findUser, setPassword } = await import('../src/auth.js');
for (const [name, pw] of [['ibi', 'test-password-1'], ['mate', 'test-password-2']]) {
  const existing = await findUser(name);
  if (existing) await setPassword(existing.id, pw);
  else await createUser({ username: name, password: pw, displayName: name });
}
await db.query(`UPDATE users SET role='owner' WHERE username='ibi'`);
await db.query(`DELETE FROM holdings`);
await db.query(`DELETE FROM card_photos`);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await p.goto(B, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
if (await p.locator('#gate').isVisible().catch(() => false)) {
  const chip = p.locator('#gatePeople button:text-is("ibi")');
  if (await chip.count()) await chip.first().click();
  else await p.fill('#liUser', 'ibi');
  await p.fill('#liPass', 'test-password-1');
  await p.click('#liGo');
  await p.waitForTimeout(3500);
}

await p.waitForSelector('#quickAdd', { timeout: 10000 });
await p.waitForFunction(() => document.querySelectorAll('#qaProduct option').length > 1, { timeout: 10000 });
await p.locator('#quickAdd').scrollIntoViewIfNeeded();

// --- the dropdowns are populated from the real checklist ------------------
const sets = await p.$$eval('#qaProduct option', (o) => o.map((x) => x.textContent));
ok(sets.length === 5, `all five sets are offered (${sets.length}: ${sets.join(' / ')})`);

await p.selectOption('#qaProduct', 'C');
await p.waitForTimeout(400);
const sections = await p.$$eval('#qaSection option', (o) => o.map((x) => x.textContent));
ok(sections.length === 1 && /Base · 300/.test(sections[0]),
   `Prizm shows its one 300-card section (${sections.join(', ')})`);
const hint = await p.getAttribute('#qaNum', 'placeholder');
ok(/1.*300/.test(hint), `the box says which numbers exist (${hint})`);

await p.selectOption('#qaProduct', 'D');
await p.waitForTimeout(400);
const dSections = await p.$$eval('#qaSection option', (o) => o.map((x) => x.textContent));
ok(dSections.length === 3, `Select shows its three tiers (${dSections.length})`);
ok(dSections.some((s) => /Field Level/.test(s)), 'including Field Level');

await p.screenshot({ path: `${OUT}/1-bar.png` });

// --- the rhythm ------------------------------------------------------------
await p.selectOption('#qaProduct', 'C');
await p.waitForTimeout(400);
await p.click('#qaNum');
await p.fill('#qaNum', '245');
await p.keyboard.press('Enter');
await p.waitForTimeout(2500);

ok(await p.inputValue('#qaNum') === '', 'the number box clears itself after Enter');
const focused = await p.evaluate(() => document.activeElement && document.activeElement.id);
ok(focused === 'qaNum', `focus returns to the number box, so you can just keep typing (was: ${focused})`);
const added1 = await p.textContent('#qaRecent');
ok(/Lamine Yamal/.test(added1), `the card appears with its player name (${(added1 || '').slice(0, 60)})`);
ok(await p.locator('#qaRecent [data-shoot][data-side="front"]').count() === 1,
   'and with a camera button for the front');
ok(await p.locator('#qaRecent [data-shoot][data-side="back"]').count() === 1, 'and for the back');

// keep typing without touching the mouse
for (const n of ['181', '1']) {
  await p.keyboard.type(n);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(2000);
}
const rows = await p.locator('#qaRecent .qadded').count();
ok(rows === 3, `three cards logged without ever leaving the keyboard (${rows})`);
await p.screenshot({ path: `${OUT}/2-three-added.png` });

// --- a duplicate is a quantity, not a second row --------------------------
await p.keyboard.type('245');
await p.keyboard.press('Enter');
await p.waitForTimeout(2000);
const rowsAfterDupe = await p.locator('#qaRecent .qadded').count();
ok(rowsAfterDupe === 3, `typing 245 again does not add a fourth row (${rowsAfterDupe})`);
const qty = (await db.query(
  `SELECT h.qty FROM holdings h JOIN sku_detail d ON d.sku_id = h.sku_id
    JOIN users u ON u.id = h.user_id
   WHERE u.username = 'ibi' AND d.card_number = '245' AND d.product_code = 'C'`)).rows[0];
ok(Number(qty?.qty) === 2, `it logged a duplicate instead (qty ${qty?.qty})`);

// --- several numbers at once ----------------------------------------------
await p.keyboard.type('2 3 4');
await p.keyboard.press('Enter');
await p.waitForTimeout(3000);
const many = (await db.query(
  `SELECT COUNT(*)::int n FROM holdings h JOIN sku_detail d ON d.sku_id = h.sku_id
     JOIN users u ON u.id = h.user_id
    WHERE u.username='ibi' AND d.product_code='C'`)).rows[0].n;
ok(many === 6, `"2 3 4" logged three more cards in one go (${many} total)`);

// --- a wrong number is useful ---------------------------------------------
await p.keyboard.type('9999');
await p.keyboard.press('Enter');
await p.waitForTimeout(2000);
const msg = await p.textContent('#qaMsg');
ok(/9999/.test(msg) && /300/.test(msg), `a number that does not exist says what does (${msg})`);
ok(await p.locator('#qaMsg.bad').count() === 1, 'and is shown as a problem, not a success');
await p.screenshot({ path: `${OUT}/3-bad-number.png` });

// --- extras ----------------------------------------------------------------
await p.click('#qaMore');
await p.waitForTimeout(300);
ok(await p.locator('#qaExtras').isVisible(), 'Extras opens the parallel row');
const pars = await p.$$eval('#qaParallel option', (o) => o.map((x) => x.value));
ok(pars.includes('Gold (#/10)'), `the parallels are the real checklist ones (${pars.length} options)`);
ok(pars.includes('__other'), 'with an escape hatch for colours not on the checklist');
await p.selectOption('#qaParallel', 'Gold (#/10)');
await p.click('#qaNum');
await p.keyboard.type('181');
await p.keyboard.press('Enter');
await p.waitForTimeout(2500);
const goldRow = (await db.query(
  `SELECT d.parallel_name, d.print_run FROM holdings h JOIN sku_detail d ON d.sku_id=h.sku_id
     JOIN users u ON u.id=h.user_id
    WHERE u.username='ibi' AND d.card_number='181' AND d.parallel_name IS NOT NULL`)).rows[0];
ok(goldRow?.parallel_name === 'Gold (#/10)' && Number(goldRow.print_run) === 10,
   `the parallel and its print run are recorded (${JSON.stringify(goldRow)})`);
const warn = await p.textContent('#qaMsg');
await p.screenshot({ path: `${OUT}/4-extras.png` });

// The base #181 and the Gold #181 must be SEPARATE lines - same card, different things.
const oneEightyOnes = (await db.query(
  `SELECT COUNT(*)::int n FROM holdings h JOIN sku_detail d ON d.sku_id=h.sku_id
     JOIN users u ON u.id=h.user_id
    WHERE u.username='ibi' AND d.card_number='181' AND d.product_code='C'`)).rows[0].n;
ok(oneEightyOnes === 2, `base #181 and Gold #181 are separate lines (${oneEightyOnes})`);

// --- the set and section survive a reload ---------------------------------
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(3000);
await p.waitForFunction(() => document.querySelectorAll('#qaProduct option').length > 1, { timeout: 10000 });
await p.waitForTimeout(600);
ok(await p.inputValue('#qaProduct') === 'C',
   `the set you picked is still picked after a reload (${await p.inputValue('#qaProduct')})`);

// --- CSV ------------------------------------------------------------------
const csv = await p.evaluate(async () => (await fetch('/api/export.csv')).text());
const lines = csv.trim().split(/\r?\n/);
ok(/^﻿?set_code,set_name,section,card_number,player/.test(lines[0]),
   `the CSV has a readable header (${lines[0].slice(0, 50)})`);
ok(lines.length >= 8, `and one row per line held (${lines.length - 1} rows)`);
ok(/photo_front,photo_back\s*$/.test(lines[0]), 'ending in the two photo columns');
ok(lines.some((l) => /Gold \(#\/10\)/.test(l)), 'the Gold parallel is in there');

ok(errs.length === 0, `no page errors (${errs.join(' | ')})`);

console.log(JSON.stringify({ passed: note.length, failed: fails.length, fails, note,
                             stickyWarning: warn, screenshots: OUT }, null, 2));
await b.close();
await db.end();
process.exit(fails.length ? 1 : 0);
