/**
 * Import a file of bulk-add lines straight into somebody's collection.
 *
 * The web paste box is the right tool for ten cards off a stack. It is the wrong tool for a
 * hundred-line file you already have, because the value of the review table — looking at each
 * row — is exactly what nobody does at line 80.
 *
 * So this trades the per-row review for a **whole-file** one: it runs the identical matcher,
 * prints what it would do, and writes nothing until you say so again. Same guarantee, better
 * suited to the shape of the input.
 *
 *   npx tsx src/cli/import-lines.ts cards.txt                  # dry run, the default
 *   npx tsx src/cli/import-lines.ts cards.txt --user ibi        # into a named account
 *   npx tsx src/cli/import-lines.ts cards.txt --commit          # actually write
 *   npx tsx src/cli/import-lines.ts cards.txt --commit --ai     # let the model resolve leftovers
 *
 * Dry run is the default rather than a flag, because the failure being guarded against is
 * silent and permanent: a hundred holdings on the wrong account, or attached to the wrong
 * cards, is far harder to unpick than to prevent. Typing the command twice is cheap.
 */

import { readFile } from 'node:fs/promises';
import { addHolding } from '../collection.js';
import { parseQuickAdd } from '../collection/quickAdd.js';
import { findUser, ownerUser } from '../auth.js';
import { one, pool } from '../db.js';
import { saveValuation, valueSku } from '../valuation/engine.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (n: string) => args.includes(n);
const val = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const COMMIT = flag('--commit');
const ALLOW_LLM = flag('--ai');

function fmt(n: number, w: number) { return String(n).padStart(w); }

try {
  if (!file) throw new Error('usage: import-lines.ts <file.txt> [--user name] [--commit] [--ai]');

  const wanted = val('--user');
  const user = wanted ? await findUser(wanted) : await ownerUser();
  if (!user) throw new Error(wanted ? `no account called "${wanted}"` : 'no owner account exists');
  if (wanted && !user.active) throw new Error(`"${user.username}" is disabled`);

  const text = await readFile(file, 'utf8');
  const { lines, summary } = await parseQuickAdd(text, { allowLlm: ALLOW_LLM });

  // What will be written. Two shapes, exactly as the web commit uses:
  //  - an existing SKU;
  //  - a known card + a known parallel whose SKU row has simply never been created.
  // Anything needing a human choice is listed and skipped, never guessed at.
  const ready = lines.filter((l) => l.skuId || (l.createsSku && l.cardId));
  const needsYou = lines.filter((l) => !ready.includes(l));

  console.log('');
  console.log(`  ${file}  ->  ${user.username}${COMMIT ? '' : '   (DRY RUN)'}`);
  console.log(`  ${fmt(lines.length, 4)} lines read`);
  console.log(`  ${fmt(ready.length, 4)} will be added  (${
    ready.reduce((n, l) => n + l.qty, 0)} cards)`);
  console.log(`  ${fmt(needsYou.length, 4)} skipped, listed below`);
  console.log('');

  const created = ready.filter((l) => l.createsSku);
  if (created.length) {
    console.log(`  ${created.length} are the first of that version you have recorded. The card and`);
    console.log('  the parallel are both on the checklist, so the SKU is created as bookkeeping:');
    for (const l of created.slice(0, 5)) console.log(`      ${l.raw}  ->  ${l.reason}`);
    if (created.length > 5) console.log(`      ... and ${created.length - 5} more`);
    console.log('');
  }

  if (needsYou.length) {
    console.log('  Needs a decision, so left alone. Add these through the web paste box, where');
    console.log('  you can pick the card:');
    for (const l of needsYou) {
      console.log(`      ${l.raw.padEnd(42)} ${l.reason ?? 'no match'}`);
    }
    console.log('');
  }

  if (!COMMIT) {
    console.log('  Nothing was written. Re-run with --commit to apply.');
    console.log('');
    process.exit(0);
  }

  // --- write ---------------------------------------------------------------
  let added = 0;
  const failed: Array<{ raw: string; error: string }> = [];
  const skuIds: number[] = [];

  for (const l of ready) {
    try {
      const res = await addHolding({
        userId: user.id,
        // `skuId` when it exists; otherwise the card plus the checklist's own parallel name,
        // which is what stops a duplicate "Blue" appearing beside "Blue (#/199)".
        skuId: l.skuId ?? undefined,
        cardId: l.skuId ? undefined : l.cardId ?? undefined,
        parallelName: l.skuId ? undefined : l.parallelName ?? undefined,
        printRun: l.skuId ? undefined : l.printRun ?? undefined,
        grader: l.grader ?? undefined,
        grade: l.grade ? Number(l.grade) : undefined,
        qty: l.qty,
        costBasisAud: l.paidAud ?? undefined,
        notes: `imported: ${l.raw.slice(0, 100)}`,
      });
      if (res.skuId) { skuIds.push(res.skuId); added++; }
    } catch (e: any) {
      failed.push({ raw: l.raw, error: e.message });
    }
  }

  console.log(`  added ${added} lines`);
  if (failed.length) {
    console.log(`  ${failed.length} failed:`);
    for (const f of failed.slice(0, 10)) console.log(`      ${f.raw}  ->  ${f.error}`);
  }

  // Price them, sequentially. A hundred concurrent valuations would exhaust the pool on the
  // machine doing the import, and there is no hurry here.
  let priced = 0;
  for (const skuId of skuIds) {
    try {
      const v = await valueSku({ skuId, marketplaceCode: null });
      if (v) { await saveValuation(v); priced++; }
    } catch { /* a valuation failure must never lose the holding */ }
  }
  console.log(`  priced ${priced}`);

  const tot = await one<{ lines: number; cards: number; value: number }>(
    `SELECT COUNT(*)::int AS lines, COALESCE(SUM(qty),0)::int AS cards,
            COALESCE(SUM(total_value_aud),0) AS value
       FROM portfolio WHERE user_id = $1`, [user.id]);
  console.log('');
  console.log(`  ${user.username} now holds ${tot?.lines ?? 0} lines / ${tot?.cards ?? 0} cards`
            + `, carried at about A$${Number(tot?.value ?? 0).toFixed(2)}`);
  console.log('  Those values are seeded estimates, not observed sales — soldComps is still 0.');
  console.log('');
  void summary;
} catch (e: any) {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
