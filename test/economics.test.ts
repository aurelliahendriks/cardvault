import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gemRate } from '../src/recommend/grading.ts';
import { classifyPlayer, timingView } from '../src/recommend/timing.ts';

test('classifies players into decay tiers', () => {
  assert.equal(classifyPlayer('Lionel Messi', 'Argentina', '', true), 'icon');
  assert.equal(classifyPlayer('Cristiano Ronaldo', 'Portugal', '', true), 'icon');
  assert.equal(classifyPlayer('Lamine Yamal', 'Spain', '', true), 'elite');
  assert.equal(classifyPlayer('Gilberto Mora', 'Mexico', 'RR', true), 'breakout_rookie');
  assert.equal(classifyPlayer('Some Guy', 'Mexico', '', false), 'host_nation');
  assert.equal(classifyPlayer('Some Guy', 'Cymru', '', false), 'ordinary');
});

test('icons carry almost no sell urgency; breakout rookies carry a lot', () => {
  const now = new Date('2026-08-20T00:00:00Z');   // one month after the final
  const messi = timingView({ player: 'Lionel Messi', team: 'Argentina', subset: '', hot: true, valueAud: 7000, now });
  const mora = timingView({ player: 'Gilberto Mora', team: 'Mexico', subset: 'RR', hot: true, valueAud: 60, now });

  assert.ok(messi.urgency < 0.2, `messi urgency ${messi.urgency}`);
  assert.ok(mora.urgency > messi.urgency * 2, `mora ${mora.urgency} vs messi ${messi.urgency}`);
  assert.ok(messi.retain90 > mora.retain90);
  assert.ok(messi.retain90 > 0.95);
});

test('projected 90-day decay cost scales with card value', () => {
  const now = new Date('2026-08-20T00:00:00Z');
  const cheap = timingView({ player: 'Gilberto Mora', team: 'Mexico', subset: 'RR', hot: true, valueAud: 50, now });
  const dear = timingView({ player: 'Gilberto Mora', team: 'Mexico', subset: 'RR', hot: true, valueAud: 500, now });
  assert.ok(Math.abs(dear.cost90Aud / cheap.cost90Aud - 10) < 0.5);
});

test('an observed uptrend reduces urgency, a downtrend raises it', () => {
  const base = { player: 'Some Star', team: 'Brazil', subset: '', hot: true, valueAud: 200, now: new Date('2026-09-01T00:00:00Z') };
  const flat = timingView(base);
  const up = timingView({ ...base, trend30dPct: 20 });
  const down = timingView({ ...base, trend30dPct: -20 });
  assert.ok(up.urgency < flat.urgency);
  assert.ok(down.urgency > flat.urgency);
});

test('retention is monotonically decreasing over the horizons', () => {
  const t = timingView({ player: 'Gilberto Mora', team: 'Mexico', subset: 'RR', hot: true, valueAud: 100,
                         now: new Date('2026-08-01T00:00:00Z') });
  assert.ok(t.retain30 >= t.retain90);
  assert.ok(t.retain90 >= t.retain180);
  assert.ok(t.retain180 > 0);
});

test('gem rates punish full-bleed inserts relative to base', () => {
  assert.ok(gemRate('Kaboom!', 'B') < gemRate('Base', 'B'));
  assert.ok(gemRate('Kaboom!', 'B') < 0.3);
  assert.ok(gemRate('Base Optic', 'A') > gemRate('Beautiful Game Autographs', 'A'));
});
