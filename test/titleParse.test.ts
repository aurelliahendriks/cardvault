import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTitle, printRunFromParallelName } from '../src/match/titleParse.ts';

test('extracts card number, player and section from a normal eBay title', () => {
  const p = parseTitle('2026 Panini FIFA World Cup Gilberto Mora #214 Rated Rookie Mexico RC');
  assert.equal(p.cardNumber, '214');
  assert.equal(p.isRookie, true);
  assert.match(p.playerGuess, /Gilberto Mora/);
  assert.ok(p.productHints.includes('B'));
  assert.equal(p.reject, null);
});

test('reads grades including half grades and gem-mint phrasing', () => {
  assert.deepEqual(
    (({ grader, grade }) => ({ grader, grade }))(parseTitle('Messi Kaboom PSA 10 GEM MT')),
    { grader: 'PSA', grade: 10 },
  );
  assert.deepEqual(
    (({ grader, grade }) => ({ grader, grade }))(parseTitle('Yamal Donruss BGS 9.5')),
    { grader: 'BGS', grade: 9.5 },
  );
  const bl = parseTitle('Mbappe Optic BGS Black Label');
  assert.equal(bl.grader, 'BGS');
  assert.equal(bl.grade, 10);
});

test('reads print runs and does not confuse them with dates or scores', () => {
  assert.equal(parseTitle('Yamal Gold /10 Donruss').printRun, 10);
  assert.equal(parseTitle('Mora Purple Laser 23/99').printRun, 99);
  assert.equal(parseTitle('Messi Kaboom 1/1 Superfractor').printRun, 1);
  assert.equal(parseTitle('Messi Kaboom 1 of 1').isOneOfOne, true);
  // a bare year must not become a print run
  assert.equal(parseTitle('2026 Panini World Cup Messi #10').printRun, null);
});

test('one-of-one listings survive the lot filter', () => {
  const p = parseTitle('Lionel Messi Kaboom 1 of 1 Panini World Cup 2026');
  assert.equal(p.reject, null);
  assert.equal(p.isOneOfOne, true);
});

test('rejects lots, breaks, sealed product, stickers and reprints', () => {
  assert.equal(parseTitle('Lot of 25 Panini World Cup 2026 base cards').reject, 'lot');
  assert.equal(parseTitle('Mexico PYT random team break spot World Cup').reject, 'break_slot');
  assert.equal(parseTitle('Panini World Cup 2026 Hobby Box sealed').reject, 'sealed_product');
  assert.equal(parseTitle('Panini World Cup 2026 sticker album complete').reject, 'sticker');
  assert.equal(parseTitle('Messi REPRINT Kaboom novelty card').reject, 'reprint');
  assert.equal(parseTitle('Argentina jersey Messi World Cup 2026').reject, 'not_a_card');
});

test('identifies insert sections, preferring the longest match', () => {
  assert.ok(parseTitle('Ronaldo Kaboom! Panini World Cup 2026').sectionHints.includes('Kaboom!'));
  assert.ok(parseTitle('Yamal Base Optic Donruss Road to World Cup').sectionHints.includes('Base Optic'));
  assert.ok(parseTitle('Mbappe Night Moves Donruss').sectionHints.includes('Night Moves'));
});

test('strips accents so Mbappé matches Mbappe', () => {
  const p = parseTitle('2026 Panini Kylian Mbappé #77 France');
  assert.match(p.normalized, /Mbappe/);
});

test('structure score rises with recoverable structure', () => {
  const rich = parseTitle('2026 Panini FIFA World Cup Lamine Yamal #10 Kaboom! Gold /10 PSA 10');
  const poor = parseTitle('soccer card nice');
  assert.ok(rich.structureScore > 0.8, `expected >0.8, got ${rich.structureScore}`);
  assert.ok(poor.structureScore < 0.4, `expected <0.4, got ${poor.structureScore}`);
});

test('pulls print runs out of checklist parallel names', () => {
  assert.equal(printRunFromParallelName('Gold (#/10)'), 10);
  assert.equal(printRunFromParallelName('Silver (unnumbered; Rated Rookies #/349)'), 349);
  assert.equal(printRunFromParallelName('Bronze'), null);
});

// ---------------------------------------------------------------------------
// Products C, D and E
//
// These arrived after the parser was written for a two-product world, and every one of the
// assertions below failed before the vocabulary was extended. The failure was quiet rather
// than loud: an unrecognised brand word stays in the residue, becomes part of the player
// guess, and drags the trigram similarity below the accept threshold — so a card that is
// on the checklist comes back as "pick which card this is".
// ---------------------------------------------------------------------------

test('recognises Select, Topps Chrome and Prizm FIFA as products', () => {
  const select = parseTitle('mora select 217');
  assert.deepEqual(select.productHints, ['D']);
  assert.equal(select.productHintStrong, true);

  const topps = parseTitle('salah topps chrome 136');
  assert.deepEqual(topps.productHints, ['E']);
  assert.equal(topps.productHintStrong, true);

  // Qualified Prizm is decisive.
  const prizm = parseTitle('2025-26 Panini Prizm FIFA Lamine Yamal #245');
  assert.deepEqual(prizm.productHints, ['C']);
  assert.equal(prizm.productHintStrong, true);
});

test('Select beats Donruss on "Select Road to World Cup"', () => {
  // Both rules match the phrase. Select is the more specific of the two and is ordered first.
  const p = parseTitle('2025-26 Panini Select Road to FIFA World Cup Messi #210');
  assert.deepEqual(p.productHints, ['D']);
});

test('a bare "prizm" stays ambiguous on purpose', () => {
  // Product C is Panini Prizm FIFA; product B contains a 48-card section called Prizm.
  // Guessing either way misfiles the other, so the parser declines to guess.
  const p = parseTitle('messi prizm');
  assert.deepEqual(p.productHints, []);
  assert.equal(p.productHintStrong, false);
});

test('2025-26 no longer means Donruss on its own', () => {
  // It was a strong signal for A while Donruss was the only 2025-26 set in the database.
  // Prizm, Select and Topps Chrome are all 2025-26 as well, so as a strong rule it would
  // now pull three whole products into A.
  const p = parseTitle('2025-26 soccer card #12');
  assert.equal(p.productHintStrong, false);
  assert.deepEqual([...p.productHints].sort(), ['A', 'C', 'D', 'E']);
});

test('brand words are stripped out of the player guess', () => {
  // "salah topps 136" scored 0.375 against "Mohamed Salah" — below the accept threshold —
  // purely because `topps` was still attached to the name.
  // A bare card number with no `#` is left in the guess; that is long-standing behaviour and
  // costs almost nothing, because a digit run shares no trigrams with a name. A brand word
  // does, which is why it is the thing being asserted about here.
  for (const [title, brand] of [
    ['salah topps 136 red refractor /5', 'topps'],
    ['mora select 217', 'select'],
    ['yamal prizm 245 pink power', 'prizm'],
    ['bellingham topps chrome 40 refractor', 'chrome'],
  ] as const) {
    const guess = parseTitle(title).playerGuess.toLowerCase();
    assert.ok(!guess.includes(brand), `${title} -> playerGuess "${guess}" still contains ${brand}`);
    assert.match(guess, /^[a-z]+/, title);
  }
});

test('reads the new parallel vocabulary, preferring the longest phrase', () => {
  assert.deepEqual(parseTitle('salah topps 136 red refractor /5').parallelHints, ['red refractor']);
  assert.ok(parseTitle('yamal prizm 245 pink power').parallelHints.includes('pink power'));
  assert.ok(parseTitle('haaland select 218 red pandora').parallelHints.includes('red pandora'));
  // "teal ice" must not also register a bare "ice". ("prizm" is separately a real parallel
  // word — product B has Silver Prizm, Red Prizm, Blue Prizm and Orange Prizm — so it
  // legitimately appears alongside it.)
  const ice = parseTitle('mbappe prizm 12 teal ice /99').parallelHints;
  assert.ok(ice.includes('teal ice'));
  assert.ok(!ice.includes('ice'), `bare "ice" double-counted: ${JSON.stringify(ice)}`);
});

test("Select's three base tiers are sections, not parallels", () => {
  // Terrace 1-100, Mezzanine 101-200, Field Level 201-250 — separate card numbers and
  // separate scarcity, so the tier narrows which card you mean.
  assert.ok(parseTitle('haaland select 218 field level').sectionHints.includes('Base Field Level'));
  assert.ok(parseTitle('select terrace 44').sectionHints.includes('Base Terrace'));
  assert.ok(parseTitle('select mezzanine 150').sectionHints.includes('Base Mezzanine'));
  assert.equal(parseTitle('haaland select 218 field level').parallelHints.length, 0);
});
