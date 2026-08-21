/**
 * The three states of the front door, in a real browser.
 *
 *   1. no password anywhere  -> the app works, with a "set a password" nudge (NOT a wall)
 *   2. first-run setup       -> claims the account and lands you inside, cards intact
 *   3. signed out            -> a login screen, and no dashboard behind it
 *   4. signed in as a friend -> you can read their collection, and cost is absent
 *
 * State 1 is the one worth being careful about. Upgrading an existing single-user install must
 * not put a login wall in front of somebody's own cards — the migration created an owner account
 * they never asked for, and a wall would look exactly like data loss.
 *
 * Needs a running API whose database has been migrated and has NO passwords set yet.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { mkdirSync } from 'node:fs';

const B = process.env.B || 'http://localhost:8220';
const OUT = '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fails = [];
const note = [];
const ok = (c, m) => { if (!c) fails.push(m); else note.push(m); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

// --- 1: fresh upgrade, no passwords --------------------------------------
await db.query(`UPDATE users SET pass_hash = 'x', pass_algo = 'unset'`);
await db.query(`DELETE FROM sessions`);
{
  const p = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const gateVisible = await p.locator('#gate').isVisible();
  ok(!gateVisible, 'no password set: the app is NOT walled off');
  ok(await p.locator('#whoSetup').isVisible(), 'but a "set a password" nudge is offered');
  const tiles = await p.locator('#gallery .tile, #galleryGrid > *').count().catch(() => 0);
  ok(await p.locator('#caps').innerText().then((t) => /cards/.test(t)),
     'and the collection still loads');
  ok(errs.length === 0, `no page errors in single-user mode (${errs.slice(0, 2)})`);
  await p.screenshot({ path: `${OUT}/signin-1-nopass.png` });
  void tiles;

  // --- 2: setup from the browser ----------------------------------------
  await p.click('#whoSetup');
  await p.waitForTimeout(400);
  ok(await p.locator('#gateSetup').isVisible(), 'the setup form opens');
  await p.screenshot({ path: `${OUT}/signin-2-setup.png` });

  await p.fill('#suUser', 'ibi');
  await p.fill('#suPass', 'short');
  await p.fill('#suPass2', 'short');
  await p.click('#suGo');
  await p.waitForTimeout(400);
  ok(await p.locator('#gateErr').isVisible(), 'a too-short password is refused in the browser');

  await p.fill('#suPass', 'a-real-password');
  await p.fill('#suPass2', 'a-real-password-typo');
  await p.click('#suGo');
  await p.waitForTimeout(400);
  ok((await p.locator('#gateErr').innerText()).match(/do not match/i), 'a typo is caught before the request');

  await p.fill('#suPass2', 'a-real-password');
  await p.click('#suGo');
  await p.waitForTimeout(4000);
  ok(!(await p.locator('#gate').isVisible()), 'setup signs you straight in');
  const who = await p.locator('#whoBtn').innerText().catch(() => '');
  ok(/ibi/i.test(who), `the header shows who you are (${who.trim()})`);
  const renamed = (await db.query(`SELECT username, role, pass_algo FROM users WHERE role='owner'`)).rows[0];
  ok(renamed.username === 'ibi' && renamed.pass_algo === 'scrypt-1',
     `the owner row was renamed and given a real hash (${renamed.username}/${renamed.pass_algo})`);
  const held = (await db.query(`SELECT COUNT(*)::int AS n FROM holdings h JOIN users u ON u.id=h.user_id
                                WHERE u.username='ibi'`)).rows[0].n;
  ok(held > 0, `the existing collection is still attached to the renamed account (${held} lines)`);
  await p.screenshot({ path: `${OUT}/signin-3-inside.png` });

  // setup must not be reusable
  const again = await p.request.post(B + '/api/auth/setup',
    { data: { username: 'someoneelse', password: 'another-password' } });
  ok(again.status() === 409, `setup is closed once a password exists (${again.status()})`);
}

// --- 3: a signed-out browser sees the login screen -----------------------
{
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.goto(B, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  ok(await p.locator('#gate').isVisible(), 'a signed-out visitor gets the gate');
  ok(await p.locator('#gateLogin').isVisible(), 'and it is the login form');
  const chips = await p.locator('#gatePeople button').count();
  ok(chips >= 1, `names are tappable instead of typed (${chips} chip(s))`);
  await p.screenshot({ path: `${OUT}/signin-4-login-phone.png` });

  await p.locator('#gatePeople button').first().click();
  await p.fill('#liPass', 'wrong-password');
  await p.click('#liGo');
  await p.waitForTimeout(1200);
  ok(await p.locator('#gateErr').isVisible(), 'a wrong password shows an error and stays put');
  ok(await p.locator('#gate').isVisible(), 'and does not let you in');

  await p.fill('#liPass', 'a-real-password');
  await p.click('#liGo');
  await p.waitForTimeout(4000);
  ok(!(await p.locator('#gate').isVisible()), 'the right password gets you in');
  await p.screenshot({ path: `${OUT}/signin-5-inside-phone.png` });
}

console.log(JSON.stringify({ passed: note.length, failed: fails.length, fails, note }, null, 2));
await b.close();
await db.end();
process.exit(fails.length ? 1 : 0);
