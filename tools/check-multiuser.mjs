/**
 * Two people, one database. Does anything leak?
 *
 * The schema previously asserted, via `UNIQUE (sku_id)` on `holdings`, that two people cannot
 * own the same card — and the `portfolio` view had no WHERE clause at all, so every dashboard
 * total was the sum of everybody's collection including cost basis. Both are the kind of bug
 * you cannot find by looking at one account, which is exactly why this test exists.
 *
 * It asserts, in order:
 *   1. two accounts can each own the same SKU, with different quantities and costs;
 *   2. each person's totals are their own, not the sum;
 *   3. a visitor can see a friend's collection and its sell advice;
 *   4. a visitor CANNOT see what the friend paid — no cost, no profit, no notes;
 *   5. a visitor cannot write to the friend's collection, by any route that accepts an id;
 *   6. deleting a sale you do not own fails rather than crediting you the card;
 *   7. the AI query path cannot read another account even when the SQL says `portfolio`;
 *   8. logged out means nothing at all is readable.
 *
 * Needs a running API with a fresh migrated database, and ADMIN_API_KEY unset or supplied.
 */
import pg from 'pg';

const B = process.env.B || 'http://localhost:8219';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fails = [];
const note = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else note.push(msg); };

/** A tiny cookie-jar fetch, because sessions are the thing under test. */
function client() {
  let cookie = '';
  return async function call(path, init = {}) {
    const r = await fetch(B + path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(init.headers || {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'manual',
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let body = null;
    try { body = await r.json(); } catch { /* empty body is fine */ }
    return { status: r.status, body };
  };
}

// --- setup: two accounts, via the CLI's own primitives ---------------------
const { createUser, findUser, setPassword } = await import('../src/auth.js');
for (const [name, pw] of [['ibi', 'test-password-1'], ['mate', 'test-password-2']]) {
  const existing = await findUser(name);
  if (existing) await setPassword(existing.id, pw);
  else await createUser({ username: name, password: pw, displayName: name });
}
// Promote ibi to owner so the owner-only routes are exercised by a real login.
await db.query(`UPDATE users SET role = 'owner' WHERE username = 'ibi'`);
await db.query(`UPDATE users SET role = 'member' WHERE username <> 'ibi'`);
await db.query(`DELETE FROM holdings`);
await db.query(`DELETE FROM sales`);

const SKU = (await db.query(`SELECT sku_id FROM sku_detail ORDER BY sku_id LIMIT 1`)).rows[0].sku_id;

// --- 8 (first, while logged out) ------------------------------------------
const anon = client();
const anonPortfolio = await anon('/api/portfolio');
ok(anonPortfolio.status === 401, `logged out cannot read the portfolio (got ${anonPortfolio.status})`);
const anonHealth = await anon('/api/health');
ok(anonHealth.status === 200, 'health is reachable without signing in');

// --- log both people in ---------------------------------------------------
const ibi = client();
const mate = client();
const l1 = await ibi('/api/auth/login', { method: 'POST', body: { username: 'ibi', password: 'test-password-1' } });
const l2 = await mate('/api/auth/login', { method: 'POST', body: { username: 'mate', password: 'test-password-2' } });
ok(l1.status === 200 && l2.status === 200, `both logins succeed (${l1.status}, ${l2.status})`);

const bad = await client()('/api/auth/login', { method: 'POST', body: { username: 'ibi', password: 'wrong' } });
ok(bad.status === 401, `a wrong password is refused (${bad.status})`);
ok(!/no such|unknown user/i.test(JSON.stringify(bad.body)),
   'the refusal does not reveal whether the username exists');

// --- 1: the same card, both collections ----------------------------------
const a1 = await ibi('/api/collection/add', { method: 'POST', body: { skuId: SKU, qty: 3, costBasisAud: 10 } });
const a2 = await mate('/api/collection/add', { method: 'POST', body: { skuId: SKU, qty: 1, costBasisAud: 99 } });
ok(a1.status === 200 && a2.status === 200, `both can add the same SKU (${a1.status}, ${a2.status})`);
const rows = (await db.query(
  `SELECT u.username, h.qty, h.cost_basis_aud FROM holdings h JOIN users u ON u.id = h.user_id
    WHERE h.sku_id = $1 ORDER BY u.username`, [SKU])).rows;
ok(rows.length === 2, `two separate holding rows exist for one SKU (got ${rows.length})`);
ok(rows.every((r) => Number(r.qty) !== 4),
   'the quantities did not merge into one row');

// --- 2: totals are per person --------------------------------------------
const pIbi = await ibi('/api/portfolio');
const pMate = await mate('/api/portfolio');
ok(pIbi.body?.totals?.cards === 3, `ibi sees 3 cards, not everyone's (saw ${pIbi.body?.totals?.cards})`);
ok(pMate.body?.totals?.cards === 1, `mate sees 1 card (saw ${pMate.body?.totals?.cards})`);
ok(Number(pIbi.body?.totals?.cost_aud) === 30, `ibi's cost is 30 (saw ${pIbi.body?.totals?.cost_aud})`);

// --- 3 + 4: visiting a friend --------------------------------------------
const visit = await mate('/api/portfolio?user=ibi');
ok(visit.status === 200, `a friend's collection is viewable (${visit.status})`);
ok(visit.body?.rows?.length === 1, `and shows their cards (${visit.body?.rows?.length} rows)`);
ok(visit.body?.isSelf === false, 'the response is marked as somebody else\'s');
const leaked = JSON.stringify(visit.body).match(/cost_basis_aud|cost_aud|profit/g);
ok(!leaked, `no cost or profit field reaches a visitor (found ${leaked && [...new Set(leaked)].join(', ')})`);
ok(visit.body?.rows?.[0]?.unit_value_aud != null, 'market value IS visible, so you can help them sell');

const visitOverview = await mate('/api/overview?user=ibi');
const leaked2 = JSON.stringify(visitOverview.body ?? {}).match(/cost_aud|cost_basis|profit/g);
ok(!leaked2, `the overview also hides cost (found ${leaked2 && [...new Set(leaked2)].join(', ')})`);

// --- 5: a visitor cannot write ------------------------------------------
const before = (await db.query(`SELECT qty FROM holdings h JOIN users u ON u.id=h.user_id
                                WHERE u.username='ibi' AND h.sku_id=$1`, [SKU])).rows[0]?.qty;
await mate(`/api/collection/${SKU}`, { method: 'PUT', body: { skuId: SKU, qty: 999 } });
await mate(`/api/collection/${SKU}`, { method: 'DELETE' });
const after = (await db.query(`SELECT qty FROM holdings h JOIN users u ON u.id=h.user_id
                               WHERE u.username='ibi' AND h.sku_id=$1`, [SKU])).rows[0]?.qty;
ok(String(before) === String(after) && after != null,
   `a friend cannot edit or delete your line (qty ${before} -> ${after})`);

// The flip side, and worth stating: those calls were not no-ops. `PUT`/`DELETE` on
// /api/collection/:skuId address YOUR row for that SKU, so mate just edited and then removed
// their own copy. That is the correct reading of "delete this card from my collection" — the
// route has no way to name someone else's row — but it means mate now owns nothing, so put it
// back before the scope tests below.
const mateGone = (await db.query(`SELECT COUNT(*)::int AS n FROM holdings h JOIN users u ON u.id=h.user_id
                                  WHERE u.username='mate'`)).rows[0].n;
ok(mateGone === 0, 'a delete removes your own copy, not the other person\'s');
await mate('/api/collection/add', { method: 'POST', body: { skuId: SKU, qty: 1, costBasisAud: 99 } });

// --- 6: sales are yours alone -------------------------------------------
const sale = await ibi('/api/sales', { method: 'POST', body: { skuId: SKU, qty: 1, priceEach: 50 } });
const saleId = sale.body?.sale?.id;
ok(saleId != null, 'a sale can be recorded');
const steal = await mate(`/api/sales/${saleId}`, { method: 'DELETE' });
ok(steal.status === 404, `a friend cannot delete your sale (${steal.status})`);
const stillThere = (await db.query(`SELECT 1 FROM sales WHERE id = $1`, [saleId])).rowCount;
ok(stillThere === 1, 'and the sale is still there');

// --- 7: the AI path cannot widen scope ----------------------------------
// Exercised through `readOnlyQuery`, the function the AI path actually calls, rather than
// hand-rolled SQL — the guarantee is only worth anything if the real code sets the GUC, and a
// pooled connection must not carry one person's id into the next person's question.
const { readOnlyQuery } = await import('../src/db.js');
const ibiId = (await db.query(`SELECT id FROM users WHERE username='ibi'`)).rows[0].id;
const mateId = (await db.query(`SELECT id FROM users WHERE username='mate'`)).rows[0].id;

const mine = await readOnlyQuery(`SELECT COUNT(*)::int AS n FROM my_portfolio`, 5000, { userId: ibiId });
ok(mine[0].n > 0, `my_portfolio returns your rows (${mine[0].n})`);

// The query names another account explicitly. It must still see nothing, because the rows are
// filtered away before the WHERE clause is ever evaluated.
const cross = await readOnlyQuery(
  `SELECT COUNT(*)::int AS n FROM my_portfolio WHERE owner_name = 'mate'`, 5000, { userId: ibiId });
ok(cross[0].n === 0, `naming another account in the SQL returns nothing (${cross[0].n})`);

// Asserted on WHOSE rows came back, not how many. Both people happen to own the same one card
// here, so equal counts would prove nothing at all — and a count-based assertion that passes
// only because the fixtures differ in size is a test that stops testing the moment they match.
const owners = async (userId) => (await readOnlyQuery(
  `SELECT DISTINCT owner_name FROM my_portfolio`, 5000, { userId })).map((r) => r.owner_name);
const ibiOwners = await owners(ibiId);
const mateOwners = await owners(mateId);
ok(JSON.stringify(ibiOwners) === '["ibi"]', `ibi's session sees only ibi's rows (${ibiOwners})`);
ok(JSON.stringify(mateOwners) === '["mate"]', `mate's session sees only mate's rows (${mateOwners})`);

// No id at all. Empty is the only acceptable answer; everybody would be the catastrophe.
const unset = await readOnlyQuery(`SELECT COUNT(*)::int AS n FROM my_portfolio`, 5000);
ok(unset[0].n === 0, `fails closed with no user id (${unset[0].n})`);

// And the id must not survive into the next call on a recycled connection. Run enough times to
// cycle the pool.
let stuck = 0;
for (let i = 0; i < 12; i++) {
  const r = await readOnlyQuery(`SELECT COUNT(*)::int AS n FROM my_portfolio`, 5000);
  if (r[0].n !== 0) stuck++;
}
ok(stuck === 0, `the user id does not persist on a pooled connection (${stuck}/12 leaked)`);

// --- owner-only routes ---------------------------------------------------
await db.query(`DELETE FROM users WHERE username = 'x1'`);
const memberAdd = await mate('/api/users', { method: 'POST', body: { username: 'x1', password: 'password-long' } });
ok(memberAdd.status === 403, `a member cannot create accounts (${memberAdd.status})`);
const ownerAdd = await ibi('/api/users', { method: 'POST', body: { username: 'x1', password: 'password-long' } });
ok(ownerAdd.status === 200, `the owner can (${ownerAdd.status})`);

// --- logout actually logs out -------------------------------------------
await mate('/api/auth/logout', { method: 'POST' });
const afterLogout = await mate('/api/portfolio');
ok(afterLogout.status === 401, `logging out revokes the session (${afterLogout.status})`);

console.log(JSON.stringify({ passed: note.length, failed: fails.length, fails, note }, null, 2));
await db.end();
process.exit(fails.length ? 1 : 0);
