import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarStyle, backdropSvg, motionCss } from '../src/media/avatarStyle.js';
import { avatarSvg } from '../src/media/images.js';

const KIT = { primary_hex: '#C60B1E', secondary_hex: '#FFD700', pattern: 'solid' };

test('a name always produces the same tile', () => {
  // A picture that changes on reload is worse than a repeated one — you stop being able
  // to recognise your own collection.
  assert.deepEqual(avatarStyle('Lamine Yamal'), avatarStyle('Lamine Yamal'));
  assert.deepEqual(avatarStyle('  lamine yamal  '), avatarStyle('Lamine Yamal'),
    'trimming and case must not change the staging');
});

test('two players in the same kit and position still differ', () => {
  // This was the actual complaint: pose comes from position and colour from nation, so
  // every Spanish midfielder rendered identically.
  const a = avatarSvg({ player: 'Pedri', team: 'Spain', kit: KIT, position: 'midfielder' });
  const b = avatarSvg({ player: 'Rodri', team: 'Spain', kit: KIT, position: 'midfielder' });
  assert.notEqual(a, b);
  // And not merely a different generated id — the actual staging has to differ.
  const strip = (s: string) => s.replace(/v[0-9a-f]{8}|p[0-9a-f]{8}|f[0-9a-f]{8}/g, '');
  assert.notEqual(strip(a), strip(b));
});

test('staging spreads across a realistic squad', () => {
  const names = ['Aaron', 'Bruno', 'Carlos', 'Diego', 'Emre', 'Felix', 'Gio', 'Hugo',
                 'Ivan', 'Jan', 'Kai', 'Luka', 'Marco', 'Nico', 'Omar', 'Pau',
                 'Quim', 'Rui', 'Sam', 'Theo', 'Uros', 'Vito', 'Will', 'Xavi'];
  const combos = new Set(names.map((n) => {
    const s = avatarStyle(n);
    return [s.backdrop, s.accent, s.mirror].join('|');
  }));
  // 24 names should not collapse into a handful of looks.
  assert.ok(combos.size >= 14, `only ${combos.size} distinct stagings across 24 names`);
});

test('every backdrop renders, and none of them fetches anything', () => {
  for (const n of ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'g', 'hh', 'iii']) {
    const s = avatarStyle(n);
    const svg = backdropSvg(s, 'uid1234');
    assert.ok(svg.length > 20, `${s.backdrop} rendered nothing`);
    assert.ok(!/<image|url\(http|href="http/.test(svg));
  }
});

test('nothing in the staging invents an attribute of a person', () => {
  // The reason the art is anonymous in the first place. Staging may vary; identity may
  // not be fabricated. If a field ever appears here called skinTone or build, this test
  // is the thing that should have stopped it.
  const s = avatarStyle('Any Player');
  assert.deepEqual(Object.keys(s).sort(),
    ['accent', 'backdrop', 'delay', 'iconic', 'mirror', 'offsetY', 'scale', 'tempo']);
});

test('iconic staging is reserved and consistent', () => {
  const plain = avatarStyle('Some Player');
  const icon = avatarStyle('Some Player', { iconic: true });
  assert.equal(icon.backdrop, 'rays');
  assert.ok(icon.scale > plain.scale || icon.backdrop !== plain.backdrop);
  const svg = avatarSvg({ player: 'Some Player', team: 'Spain', kit: KIT, iconic: true });
  assert.match(svg, /stroke="#ffe9b0"/, 'the warm rim marks the marquee treatment');
});

test('motion is per-pose, phase-shifted, and carries its own reduced-motion query', () => {
  const s = avatarStyle('Someone');
  const run = motionCss('running', s, 'u1');
  const stand = motionCss('standing', s, 'u1');
  assert.notEqual(run, stand, 'a run and an idle should not move identically');
  assert.match(run, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(run, /animation:.*-?\d/);
  // Phase offset, so a grid does not breathe in unison.
  assert.ok(s.delay <= 0);
});

test('animate:false emits no animation at all', () => {
  const still = avatarSvg({ player: 'Someone', team: 'Spain', kit: KIT, animate: false });
  assert.ok(!/@keyframes|animation:/.test(still));
  const moving = avatarSvg({ player: 'Someone', team: 'Spain', kit: KIT });
  assert.match(moving, /@keyframes/);
});

test('a real photograph is never animated or restaged', () => {
  const svg = avatarSvg({
    player: 'Someone', team: 'Spain', kit: KIT,
    portraitDataUri: 'data:image/png;base64,AAAA',
  });
  assert.ok(!/@keyframes/.test(svg), 'a photograph does not need staging or motion');
  assert.match(svg, /<image href="data:image\/png/);
});
