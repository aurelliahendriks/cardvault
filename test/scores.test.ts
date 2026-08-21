import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rarityScore, conditionScore, marketScore, scoreCard } from '../src/valuation/scores.js';

// ---------------------------------------------------------------------------
// The invariant that justifies three scores instead of one
// ---------------------------------------------------------------------------

test('rarity is untouched by anything the market does', () => {
  const card = { print_run: 49, parallel_name: 'Blue' };
  const quiet = scoreCard({ ...card, value_aud: 80, top_value_aud: 24000, n_comps: 2, trend_30d_pct: -4 });
  const hot = scoreCard({ ...card, value_aud: 900, top_value_aud: 24000, n_comps: 22, trend_30d_pct: 71 });

  // The whole point: a /49 does not become scarcer because its player had a good week.
  assert.equal(quiet.rarity.score, hot.rarity.score);
  assert.equal(quiet.rarity.tier, hot.rarity.tier);
  assert.ok(hot.market.score > quiet.market.score, 'market must move when demand does');
});

test('rarity is untouched by condition, and condition by rarity', () => {
  const raw = scoreCard({ print_run: 10, value_aud: 300, top_value_aud: 24000 });
  const slab = scoreCard({ print_run: 10, grader: 'PSA', grade: '10', value_aud: 300, top_value_aud: 24000 });
  assert.equal(raw.rarity.score, slab.rarity.score, 'grading does not change print supply');
  assert.ok(slab.condition.score > raw.condition.score);

  const base = conditionScore({ grader: 'PSA', grade: '10' });
  const scarce = conditionScore({ grader: 'PSA', grade: '10' });
  assert.equal(base.score, scarce.score, 'condition knows nothing about print run');
});

test('market never reads the print run', () => {
  const common = marketScore({ value_aud: 200, top_value_aud: 5000, n_comps: 6 });
  // Same price, same evidence: market must be identical regardless of scarcity, because
  // the price already contains the market's own opinion about scarcity.
  const scarce = marketScore({ value_aud: 200, top_value_aud: 5000, n_comps: 6 });
  assert.equal(common.score, scarce.score);
});

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------

test('rarity rises monotonically as print run falls', () => {
  const runs = [400, 199, 150, 100, 99, 75, 50, 49, 30, 26, 25, 15, 11, 10, 5, 2, 1];
  const scores = runs.map((r) => rarityScore({ print_run: r }).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i]! >= scores[i - 1]!,
      `/${runs[i]} (${scores[i]}) must not score below /${runs[i - 1]} (${scores[i - 1]})`);
  }
  assert.equal(scores.at(-1), 100);
});

test('within-band nudging never crosses a band boundary', () => {
  // A /150 should read above a /199 but stay below every /99, or the bands stop meaning
  // anything and the visual ladder stops matching the number.
  const worstOfBand = rarityScore({ print_run: 99 }).score;
  for (const run of [100, 120, 150, 199, 400]) {
    assert.ok(rarityScore({ print_run: run }).score < worstOfBand,
      `/${run} must stay below /99`);
  }
  assert.ok(rarityScore({ print_run: 101 }).score > rarityScore({ print_run: 399 }).score);
});

test('an unnumbered parallel scores below every numbered card', () => {
  const parallel = rarityScore({ parallel_name: 'Gold' }).score;
  assert.ok(parallel > rarityScore({}).score, 'but above plain base');
  assert.ok(parallel < rarityScore({ print_run: 400 }).score,
    'an unnumbered Gold is not scarcer than a numbered card');
});

test('gold is not scarcer than any other unnumbered parallel', () => {
  assert.equal(rarityScore({ parallel_name: 'Gold' }).score,
               rarityScore({ parallel_name: 'Purple' }).score);
});

test('print run beats the colour word', () => {
  const goldTen = rarityScore({ print_run: 10, parallel_name: 'Gold' });
  const plainTen = rarityScore({ print_run: 10, parallel_name: 'Grey' });
  assert.equal(goldTen.score, plainTen.score);
  assert.equal(goldTen.tier, 'elite');
});

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

test('a raw card is unknown, not average', () => {
  const raw = conditionScore({});
  assert.equal(raw.known, false);
  assert.match(raw.why, /absence, not an average/);
});

test('grades order correctly, per grader', () => {
  const psa = ['10', '9', '8', '7'].map((g) => conditionScore({ grader: 'PSA', grade: g }).score);
  for (let i = 1; i < psa.length; i++) assert.ok(psa[i]! < psa[i - 1]!);

  // BGS 9.5 is gem mint and sits above a PSA 9; BGS 9 does not.
  assert.ok(conditionScore({ grader: 'BGS', grade: '9.5' }).score
          > conditionScore({ grader: 'PSA', grade: '9' }).score);
  assert.ok(conditionScore({ grader: 'BGS', grade: '9' }).score
          < conditionScore({ grader: 'BGS', grade: '9.5' }).score);
});

test('a Black Label tops the scale and a missing grade does not', () => {
  assert.equal(conditionScore({ grader: 'BGS', grade: 'Black Label' }).score, 100);
  const unclear = conditionScore({ grader: 'PSA', grade: null });
  assert.equal(unclear.known, false);
  assert.ok(unclear.score < conditionScore({ grader: 'PSA', grade: '9' }).score);
});

test('your own note about a raw card never scores like a slab', () => {
  const note = conditionScore({ condition: 'near mint' });
  assert.equal(note.known, false);
  assert.ok(note.score < conditionScore({ grader: 'PSA', grade: '8' }).score,
    'a self-assessment must stay below any third-party grade');
});

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

test('market rises with price, on a log scale', () => {
  const at = (v: number) => marketScore({ value_aud: v, top_value_aud: 24000, n_comps: 8 }).score;
  assert.ok(at(5) < at(50) && at(50) < at(500) && at(500) < at(24000));
  // Log placement: the A$24k card must not flatten a A$500 card to nothing.
  assert.ok(at(500) > at(24000) * 0.55,
    'a linear scale would collapse the middle of the collection to zero');
});

test('thin evidence is discounted, and reported as unknown', () => {
  const solid = marketScore({ value_aud: 400, top_value_aud: 5000, n_comps: 14, confidence: 0.9 });
  const thin = marketScore({ value_aud: 400, top_value_aud: 5000, n_comps: 1, confidence: 0.2 });
  assert.ok(solid.score > thin.score);
  assert.equal(marketScore({ value_aud: 400, top_value_aud: 5000, n_comps: 0 }).known, false);
  assert.equal(marketScore({ value_aud: null }).score, 0);
});

test('trend moves market but cannot dominate it', () => {
  const flat = marketScore({ value_aud: 300, top_value_aud: 5000, n_comps: 8, trend_30d_pct: 0 });
  const up = marketScore({ value_aud: 300, top_value_aud: 5000, n_comps: 8, trend_30d_pct: 60 });
  const down = marketScore({ value_aud: 300, top_value_aud: 5000, n_comps: 8, trend_30d_pct: -60 });
  assert.ok(up.score > flat.score && flat.score > down.score);
  // A cheap card on a tear must not outscore an expensive quiet one.
  const cheapHot = marketScore({ value_aud: 12, top_value_aud: 5000, n_comps: 8, trend_30d_pct: 90 });
  const dearQuiet = marketScore({ value_aud: 2400, top_value_aud: 5000, n_comps: 8, trend_30d_pct: 0 });
  assert.ok(dearQuiet.score > cheapHot.score);
});

test('every score stays inside 0-100', () => {
  const extremes = [
    { print_run: 1, grader: 'BGS', grade: 'Black Label', value_aud: 1e6, top_value_aud: 1e6,
      trend_30d_pct: 400, n_comps: 900, confidence: 1, sales_per_month: 400 },
    { print_run: 9999, value_aud: 0.01, top_value_aud: 1e6, trend_30d_pct: -99, n_comps: 0, confidence: 0 },
  ];
  for (const e of extremes) {
    const s = scoreCard(e as any);
    for (const [k, v] of Object.entries(s)) {
      assert.ok(v.score >= 0 && v.score <= 100, `${k} out of range: ${v.score}`);
    }
  }
});
