/**
 * Pin the one promise the review step is built on: parsing writes nothing.
 *
 * This is a regression test for a real bug, not a hypothetical. `resolveListing` creates the
 * SKU it matches — correct for ingest, where a comp on an unrecorded parallel would
 * otherwise be dropped — and bulk entry called it directly. So `POST /api/collection/parse`,
 * documented and captioned as read-only, was inserting `skus` rows, and for an unrecognised
 * colour word on a numbered card an `Unidentified /37` **parallel** as well. Typing a typo
 * and clicking nothing left permanent reference data behind.
 *
 * The probe is deliberately a line that *matches a card confidently* and names a parallel
 * that cannot exist. Anything that fails to match proves nothing: the write happened on the
 * accept path.
 *
 * Needs DATABASE_URL and a running API (B). Not part of `npm test`, which is pure unit.
 */
import pg from 'pg';

const B = process.env.B || 'http://localhost:8080';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const counts = async () => {
  const { rows } = await db.query(`
    SELECT (SELECT count(*) FROM skus)      ::int AS skus,
           (SELECT count(*) FROM parallels) ::int AS parallels,
           (SELECT count(*) FROM cards)     ::int AS cards,
           (SELECT count(*) FROM holdings)  ::int AS holdings`);
  return rows[0];
};

// A real card number and surname, so tier 1 accepts, plus a colour nobody printed.
const PROBE = [
  '#91 ronaldo mango sorbet /37',
  'mora 214 x2 @4.50',
  'yamal base blue /49',
  'messi kaboom psa 10',
].join('\n');

/**
 * Sign in if the instance has accounts.
 *
 * This check used to post straight at /api/collection/parse, which worked only because the
 * database it ran against happened to have no passwords set — in that state the API attaches
 * the owner to every request. Run it after anything that creates an account and it fails with
 * a bare 401 and no clue why. The check is about whether parsing writes to the database; it
 * should not also be an accident report about who ran before it.
 */
async function session() {
  const health = await (await fetch(`${B}/api/health`)).json().catch(() => ({}));
  if (!health.accountsInUse) return '';
  const user = process.env.CHECK_USER || 'ibi';
  const pass = process.env.CHECK_PASS || 'test-password-1';
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!r.ok) {
    throw new Error(`this instance has accounts and "${user}" could not sign in (${r.status}). `
      + 'Set CHECK_USER/CHECK_PASS.');
  }
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const cookie = await session();

const before = await counts();
const res = await fetch(`${B}/api/collection/parse`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ text: PROBE }),
});
if (!res.ok) throw new Error(`parse returned ${res.status}`);
const parsed = await res.json();
const after = await counts();

const failures = [];
for (const k of ['skus', 'parallels', 'cards', 'holdings']) {
  if (before[k] !== after[k]) {
    failures.push(`${k}: ${before[k]} -> ${after[k]} — parse must not write`);
  }
}

// The probe must still be *usable*: identified enough to offer the card, so the person can
// confirm it rather than retype it. A read-only mode that answers "no idea" is not a fix.
const probeLine = parsed.lines.find((l) => l.raw.includes('mango'));
if (!probeLine) failures.push('the probe line vanished from the parse output');
else {
  if (probeLine.skuId) failures.push('the probe resolved to a SKU that cannot exist');
  if (!probeLine.cardChoices?.length) failures.push('no card offered for a line whose card matched');
  if (!probeLine.createsParallel) failures.push('the row does not warn that it will declare a parallel');
}

console.log(JSON.stringify({
  before, after,
  probe: probeLine && {
    status: probeLine.status,
    skuId: probeLine.skuId,
    parallelName: probeLine.parallelName,
    printRun: probeLine.printRun,
    firstChoice: probeLine.cardChoices?.[0]?.label,
    choices: probeLine.cardChoices?.length,
  },
  failures,
}, null, 2));

await db.end();
process.exit(failures.length ? 1 : 0);
