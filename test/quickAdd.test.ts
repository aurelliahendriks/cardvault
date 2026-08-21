import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQtyAndPrice, parallelNameFrom } from '../src/collection/quickAdd.js';

test('quantity comes off in every form people type it', () => {
  for (const [input, qty] of [
    ['mora 214 x2', 2], ['mora 214 ×2', 2], ['mora 214 2x', 2],
    ['mora 214 qty 3', 3], ['x5 messi kaboom', 5],
  ] as const) {
    const r = extractQtyAndPrice(input);
    assert.equal(r.qty, qty, input);
    assert.ok(!/x\s?\d|qty/i.test(r.query), `quantity left in the query: ${r.query}`);
  }
});

test('price comes off, in every form people type it', () => {
  for (const [input, paid] of [
    ['mora 214 @4.50', 4.5], ['mora 214 $12', 12], ['mora 214 paid 41.00', 41],
    ['mora 214 cost 8', 8], ['mora 214 @4,50', 4.5],
  ] as const) {
    const r = extractQtyAndPrice(input);
    assert.equal(r.paidAud, paid, input);
    assert.ok(!/@|\$|paid|cost/i.test(r.query), `price left in the query: ${r.query}`);
  }
});

test('a bare number is never taken as a price or a quantity', () => {
  // This is the whole reason the patterns are anchored. "214" is Gilberto Mora's card
  // number; reading it as a price or a count would match the wrong card entirely, and
  // silently.
  const r = extractQtyAndPrice('mora 214');
  assert.equal(r.qty, 1);
  assert.equal(r.paidAud, null);
  assert.equal(r.query, 'mora 214');
});

test('a print run survives intact', () => {
  // "/49" must reach the matcher — it is what distinguishes one parallel from another.
  const r = extractQtyAndPrice('yamal base blue /49 x2 @95');
  assert.equal(r.query, 'yamal base blue /49');
  assert.equal(r.qty, 2);
  assert.equal(r.paidAud, 95);
});

test('a grade survives intact', () => {
  const r = extractQtyAndPrice('messi kaboom psa 10 @24000');
  assert.equal(r.query, 'messi kaboom psa 10');
  assert.equal(r.paidAud, 24000);
});

test('both together, in either order', () => {
  const a = extractQtyAndPrice('mora 214 x2 @4.50');
  const b = extractQtyAndPrice('mora 214 @4.50 x2');
  assert.deepEqual([a.qty, a.paidAud, a.query], [2, 4.5, 'mora 214']);
  assert.deepEqual([b.qty, b.paidAud, b.query], [2, 4.5, 'mora 214']);
});

test('nonsense quantities and prices are ignored rather than trusted', () => {
  assert.equal(extractQtyAndPrice('mora 214 x0').qty, 1, 'zero is not a quantity');
  assert.equal(extractQtyAndPrice('mora 214 @0').paidAud, null, 'free is not a price');
  assert.equal(extractQtyAndPrice('mora 214 x9999').qty, 1,
    'four digits is not a quantity — the pattern only takes up to three');
});

test('whitespace and casing do not matter', () => {
  const r = extractQtyAndPrice('   MORA   214    X2   @4.50  ');
  assert.equal(r.query, 'MORA 214');
  assert.equal(r.qty, 2);
});

test('a declared parallel is named the way the checklist names them', () => {
  // The parser returns hints in match order, not reading order, so "blue holo" arrives
  // reversed. A parallel stored as "Holo Blue" can never be reconciled with a checklist
  // that spells it "Blue Holo" — it sits forever as a separate thing.
  assert.equal(parallelNameFrom(['holo', 'blue'], 'mora 214 blue holo /49'), 'Blue Holo');
  assert.equal(parallelNameFrom(['blue'], 'yamal base blue /49'), 'Blue');
  assert.equal(parallelNameFrom(['gold vinyl'], 'vinicius gold vinyl 1/1'), 'Gold Vinyl');
  assert.equal(parallelNameFrom([], 'mora 214'), null);
});

test('a repeated parallel word is not doubled', () => {
  assert.equal(parallelNameFrom(['teal', 'teal'], 'yamal teal /199'), 'Teal');
});

test('a hint the query does not contain still lands, at the end', () => {
  // Defensive: the parser may normalise a word before returning it. Sorting must not drop
  // the hint just because indexOf fails.
  assert.equal(parallelNameFrom(['blue', 'refractor'], 'yamal blue /49'), 'Blue Refractor');
});
