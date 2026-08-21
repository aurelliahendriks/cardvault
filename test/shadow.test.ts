import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spearman, ranks, MARKET_SCORE_VERSION, MARKET_SCORE_CALIBRATED } from '../src/valuation/shadow.js';
import { parsePopulation, describePopulation } from '../src/sources/psa.js';
import { conditionScore } from '../src/valuation/scores.js';

test('the heuristic is stamped and flagged uncalibrated', () => {
  // Weights that change whenever three sales land are worse than imperfect weights left
  // alone — and without the stamp you cannot tell which guess produced a row.
  assert.equal(MARKET_SCORE_VERSION, 'heuristic-v1');
  assert.equal(MARKET_SCORE_CALIBRATED, false);
});

test('ranks average across ties', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('spearman is monotonic-aware, not linear', () => {
  assert.equal(spearman([1, 2, 3, 4], [1, 4, 9, 16]), 1);
  assert.equal(spearman([1, 2, 3, 4], [16, 9, 4, 1]), -1);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [3, 1, 5, 2, 4])) < 0.6);
  assert.ok(Number.isNaN(spearman([1, 2], [1, 2])), 'two points is not a correlation');
});

// ---------------------------------------------------------------------------
// PSA population
// ---------------------------------------------------------------------------

const PAYLOAD = {
  PSAPopulation: {
    SpecID: 12345, Total: 40,
    Grade10: 10, Grade9Half: 2, Grade9: 18, Grade8: 8, Grade7: 4,
  },
};

test('population parses counts, higher-than and gem rate', () => {
  const p = parsePopulation(PAYLOAD, 9);
  assert.equal(p.total, 40);
  assert.equal(p.atGrade, 18);
  // "Higher" must be strictly above this grade — 10 plus the 9.5s.
  assert.equal(p.higher, 12);
  assert.equal(p.gemRate, 0.25);
  assert.equal(p.specId, 12345);
});

test('a PSA 10 has nothing higher', () => {
  assert.equal(parsePopulation(PAYLOAD, 10).higher, 0);
});

test('population never enters the condition score', () => {
  // The invariant: a PSA 10 out of 40 and a PSA 10 out of 4,000 are the same *condition*
  // and different *populations*. Condition takes no population argument at all.
  const a = conditionScore({ grader: 'PSA', grade: '10' });
  const b = conditionScore({ grader: 'PSA', grade: '10', ...(PAYLOAD as any) });
  assert.equal(a.score, b.score);
});

test('the summary reports counts and refuses to imply value', () => {
  const s = describePopulation({ population_total: 40, population_grade: 10, population_higher: 0, gem_rate: 0.25, grade: 10 })!;
  assert.match(s, /40 graded/);
  assert.match(s, /none higher/);
  assert.match(s, /not scarcity/);
  assert.equal(describePopulation(null), null);
  assert.equal(describePopulation({ population_total: null }), null);
});
