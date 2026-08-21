import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingView } from '../src/recommend/timing.js';

const NOW = new Date('2026-08-20T00:00:00Z');   // a month after the final
const base = {
  player: 'Some Star', team: 'Brazil', subset: '', hot: true,
  valueAud: 100, now: NOW,
};

test('scarcity changes the hype share, never the half-life', () => {
  const plain = timingView({ ...base });
  const scarce = timingView({ ...base, printRun: 10 });

  // This is the whole point of the remodel. Claiming a /10's hype decays more slowly is
  // unsupported; claiming less of its price was hype is defensible.
  assert.equal(plain.halfLifeDays, scarce.halfLifeDays,
    'the decay rate belongs to the player, not to the print run');
  assert.ok(scarce.model.hypeShare < plain.model.hypeShare);
  assert.ok(scarce.retain90 > plain.retain90,
    'the scarce card still loses less of its total value');
});

test('the hype component itself decays at the same proportional rate', () => {
  const plain = timingView({ ...base });
  const scarce = timingView({ ...base, printRun: 10 });

  // Strip the baseline out of each projection and the remaining premium must fall by
  // the same fraction — same tau, different exposure.
  const premiumDecay = (v: ReturnType<typeof timingView>) => {
    const lost = 1 - v.retain90;                 // fraction of price lost
    return lost / v.model.hypeShare;             // fraction of the *premium* lost
  };
  assert.ok(Math.abs(premiumDecay(plain) - premiumDecay(scarce)) < 0.02,
    `premium decayed differently: ${premiumDecay(plain)} vs ${premiumDecay(scarce)}`);
});

test('an icon has almost no hype to lose regardless of scarcity', () => {
  const icon = timingView({ ...base, player: 'Lionel Messi' });
  assert.ok(icon.model.hypeShare < 0.05);
  assert.ok(icon.retain90 > 0.99);
  assert.ok(icon.urgency <= 0.15);
});

test('thin trading widens the band without moving the projection', () => {
  const liquid = timingView({ ...base, salesPerMonth: 20 });
  const thin = timingView({ ...base, salesPerMonth: 0.2 });
  assert.equal(liquid.retain90, thin.retain90, 'liquidity must not bend the curve');
  const width = (v: ReturnType<typeof timingView>) => v.model.retain90Range[1] - v.model.retain90Range[0];
  assert.ok(width(thin) > width(liquid),
    'a card that trades quarterly deserves wider error bars, not a flatter curve');
});

test('scarcity also widens the band, for the same reason', () => {
  // Illiquidity masquerades as stability: a /10 with no recent sales looks flat because
  // nothing traded, not because demand held.
  const plain = timingView({ ...base, salesPerMonth: 1 });
  const scarce = timingView({ ...base, printRun: 10, salesPerMonth: 1 });
  assert.ok(scarce.model.uncertainty > plain.model.uncertainty);
});

test('the note explains the split rather than asserting slower decay', () => {
  const v = timingView({ ...base, printRun: 10 });
  assert.match(v.note, /event premium/);
  assert.match(v.note, /collector baseline/);
  assert.match(v.note, /not because it decays more slowly/);
});

test('grading shifts a card toward its collector baseline', () => {
  const raw = timingView({ ...base, printRun: 49 });
  const slab = timingView({ ...base, printRun: 49, grader: 'PSA' });
  assert.ok(slab.model.hypeShare < raw.model.hypeShare);
  assert.equal(slab.halfLifeDays, raw.halfLifeDays);
});
