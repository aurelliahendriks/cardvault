import { pool } from '../db.js';
import { backfillPortraits, resolvePlayer } from '../media/players.js';
import { q } from '../db.js';

const args = process.argv.slice(2);
const name = args.filter((a) => !a.startsWith('--')).join(' ');

if (name) {
  const r = await resolvePlayer(name);
  console.log(JSON.stringify(r, null, 2));
} else if (args.includes('--reset-throttled')) {
  // Rows whose recorded reason is a 429 were refused before they were ever examined, so
  // resetting them to pending is not "retry the failures" — it is correcting a status
  // that was wrong when it was written.
  const rows = await q(
    `UPDATE players
        SET lookup_status = 'pending', lookup_note = NULL, attempts = 0
      WHERE lookup_status = 'error'
        AND (lookup_note LIKE '429%' OR lookup_note ILIKE '%too many requests%')
      RETURNING name`);
  console.log(`${rows.length} rate-limited rows reset to pending.`);
  console.log('They will be fetched by the next run; no --retry needed.');
} else if (args.includes('--status')) {
  const rows = await q(`SELECT lookup_status, COUNT(*)::int AS n FROM players GROUP BY 1 ORDER BY n DESC`);
  console.table(rows);

  // A count of 'error' with no reason beside it is a dead end, and that is exactly the
  // state this landed in on the first real run: 191 errors and nothing to act on.
  const why = await q(`SELECT COALESCE(lookup_note, '(no note recorded)') AS reason, COUNT(*)::int AS n
                         FROM players WHERE lookup_status IN ('error','license_unclear','not_found')
                        GROUP BY 1 ORDER BY n DESC LIMIT 8`);
  if (why.length) {
    console.log('\nWhy they failed:');
    console.table(why);

    // Advice has to match the evidence. The first version printed the 403/user-agent tip
    // unconditionally, which sent someone looking at a rate-limit problem after the wrong
    // cause entirely.
    const reasons = why.map((r: any) => String(r.reason));
    const throttled = why
      .filter((r: any) => /^429/.test(String(r.reason)))
      .reduce((n: number, r: any) => n + Number(r.n), 0);

    if (throttled) {
      console.log(`\n${throttled} rows are stuck on a rate-limit refusal from an older run,`
        + ` when a 429 was recorded as a permanent error. They were never actually looked`
        + ` up. Clear them and they will be picked up by the next run:`);
      console.log('  node dist/cli/portraits.js --reset-throttled');
    }
    if (reasons.some((r) => /\b403\b/.test(r) && /user.?agent/i.test(r))) {
      console.log('\nA 403 mentioning the user agent means Wikimedia wants a contact in it:');
      console.log('  set WIKIMEDIA_CONTACT=you@example.com in .env, then restart the api container');
    }
    if (reasons.some((r) => /no Wikidata entity matched/.test(r))) {
      console.log('\n"no Wikidata entity matched the name" is usually a spelling variant in the'
        + ' checklist. Look one up by hand to check:');
      console.log('  node dist/cli/portraits.js "Kylian Mbappe"');
    }
  }
} else {
  const limit = Number(args.find((a) => /^--limit=/.test(a))?.split('=')[1]) || 60;
  console.log(`user agent: ${process.env.WIKIMEDIA_USER_AGENT
    || 'CardVault/1.0 (... ' + (process.env.WIKIMEDIA_CONTACT ?? 'no WIKIMEDIA_CONTACT set') + ')'}`);
  const r = await backfillPortraits({ limit, retryErrors: args.includes('--retry') });
  console.log(JSON.stringify(r, null, 2));
  if ((r as any).throttled) {
    console.log(`\n${(r as any).throttled} were rate-limited by Wikimedia and left PENDING,`
      + ` not failed — just run this again to resume. Pace self-adjusted to`
      + ` ${(r as any).paceMs}ms between requests; raise WIKIMEDIA_MIN_INTERVAL_MS in .env`
      + ` if it keeps happening.`);
  }
  console.log(`\nPortraits come from Wikidata + Wikimedia Commons. Almost all are CC BY or
CC BY-SA and REQUIRE attribution — the author, licence and source link are stored on
each row and shown wherever the portrait appears. See docs/PORTRAITS.md.`);
}
await pool.end();
