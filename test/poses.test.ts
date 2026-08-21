import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poseForPosition, figureSvg, POSE_NAMES, POSITION_EXAMPLES } from '../src/media/poses.js';
import { resolvePose, avatarSvg } from '../src/media/images.js';
import { positionIdsFromEntity } from '../src/media/players.js';

test('every position we claim to recognise maps to a pose', () => {
  for (const p of POSITION_EXAMPLES) {
    const pose = poseForPosition(p);
    assert.ok(POSE_NAMES.includes(pose), `${p} -> ${pose}`);
  }
});

test('positions map to the pose you would expect', () => {
  assert.equal(poseForPosition('goalkeeper'), 'diving');
  assert.equal(poseForPosition('Goalkeeper'), 'diving');
  assert.equal(poseForPosition('centre-forward'), 'striking');
  assert.equal(poseForPosition('striker'), 'striking');
  assert.equal(poseForPosition('winger'), 'running');
  assert.equal(poseForPosition('defensive midfielder'), 'walking');
  assert.equal(poseForPosition('centre-back'), 'sliding');
  assert.equal(poseForPosition('left-back'), 'sliding');
});

test('an unknown or missing position never guesses', () => {
  // The whole point: no position must not become a random pose, because a wrong
  // pose looks like data rather than like an absence.
  assert.equal(poseForPosition(null), 'standing');
  assert.equal(poseForPosition(undefined), 'standing');
  assert.equal(poseForPosition(''), 'standing');
  assert.equal(poseForPosition('   '), 'standing');
  assert.equal(poseForPosition('team captain'), 'standing');
  assert.equal(poseForPosition('Q11111'), 'standing');
});

test('goalkeeper is matched before the "back" rule', () => {
  // "goalkeeper" contains no "back", but this guards the ordering if someone adds a
  // label like "goalkeeper / sweeper-keeper" later.
  assert.equal(poseForPosition('sweeper-keeper'), 'diving');
});

test('a pinned pose beats the position, and a bad pin falls through', () => {
  assert.equal(resolvePose('celebrating', 'goalkeeper'), 'celebrating');
  assert.equal(resolvePose('CELEBRATING', 'goalkeeper'), 'celebrating');
  assert.equal(resolvePose('nonsense', 'goalkeeper'), 'diving');
  assert.equal(resolvePose(null, 'goalkeeper'), 'diving');
  assert.equal(resolvePose('', null), 'standing');
});

test('every pose renders valid, self-contained, colourless-input SVG geometry', () => {
  for (const pose of POSE_NAMES) {
    // Family pinned: 'traced' is the default now, and these assertions are about the
    // hand-authored stroke geometry specifically.
    const svg = figureSvg(pose, '#ffffff', '#141413', { family: 'geometry' });
    assert.match(svg, /^<g opacity=/);
    assert.equal((svg.match(/<g /g) ?? []).length, 3, `${pose}: rim pass + ink pass inside one group`);
    // The rim pass must come first or the outline paints over the figure.
    assert.ok(svg.indexOf('#141413') < svg.indexOf('#ffffff'), `${pose}: rim before ink`);
    assert.ok(!/<text|<image|href=/.test(svg), `${pose}: no text, no embedded image`);
    // Balanced tags, cheaply.
    assert.equal((svg.match(/<g/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
  }
});

test('poses stay inside the frame and clear of the caption strip', () => {
  // The tile lays a name over the bottom of the avatar. A pose whose legs run past
  // y=250 gets cut in half by it, which reads as a rendering bug.
  for (const pose of POSE_NAMES) {
    const svg = figureSvg(pose, '#fff', '#000', { family: 'geometry' });
    const nums = [...svg.matchAll(/[ML] (\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [x, y] of nums) {
      assert.ok(x! >= 20 && x! <= 280, `${pose}: x=${x} inside frame`);
      assert.ok(y! >= 20 && y! <= 250, `${pose}: y=${y} clear of the caption`);
    }
  }
});

test('the traced family covers every pose and paints a rim underneath', async () => {
  const { TRACED_POSES } = await import('../src/media/poses-art.js');
  for (const pose of POSE_NAMES) {
    assert.ok(TRACED_POSES[pose], `traced art missing for ${pose}`);
    const svg = figureSvg(pose, '#ffffff', '#141413', { family: 'traced' });
    // One path in defs, referenced twice — the rim pass and the fill pass.
    assert.equal((svg.match(/<path /g) ?? []).length, 1, 'the path is emitted once');
    assert.equal((svg.match(/<use /g) ?? []).length, 2, 'and used twice');
    // Rim first, or the outline paints over the figure it is meant to separate.
    assert.ok(svg.indexOf('#141413') < svg.lastIndexOf('#ffffff'));
    // No text, no raster, and no EXTERNAL reference. `href="#id"` is the internal
    // <use> that avoids emitting the path twice; anything with a scheme or a slash
    // would be a fetch, which an <img>-loaded SVG cannot perform anyway.
    assert.ok(!/<text|<image/.test(svg));
    for (const [, ref] of svg.matchAll(/href="([^"]+)"/g)) {
      assert.match(ref, /^#/, `external reference in ${pose}: ${ref}`);
    }
  }
});

test('an unknown traced pose falls back to the built-in geometry', () => {
  // A partial import must degrade to a hand-authored figure, not to an empty tile.
  const svg = figureSvg('standing', '#fff', '#000', { family: 'traced' });
  assert.ok(svg.length > 0);
  assert.match(figureSvg('standing', '#fff', '#000', { family: 'geometry' }), /stroke-linecap/);
});

test('the avatar draws the pose the position implies', () => {
  const kit = { primary_hex: '#75AADB', secondary_hex: '#FFFFFF', pattern: 'stripes' };
  const gk = avatarSvg({ player: 'A Keeper', team: 'Argentina', kit, position: 'goalkeeper' });
  const df = avatarSvg({ player: 'A Keeper', team: 'Argentina', kit, position: 'centre-back' });
  assert.notEqual(gk, df, 'different positions must not render identically');
  // Distinct ids per rendering, or side-by-side inlined avatars bleed gradients.
  const idOf = (s: string) => /id="k([a-z0-9]+)"/.exec(s)?.[1];
  assert.notEqual(idOf(gk), idOf(df));
});

test('a portrait still wins over any pose', () => {
  const svg = avatarSvg({
    player: 'A Player', team: 'Brazil', position: 'goalkeeper',
    portraitDataUri: 'data:image/png;base64,AAAA',
  });
  assert.match(svg, /<image href="data:image\/png/);
  assert.ok(!/stroke-linecap/.test(svg), 'no figure geometry when there is a photograph');
});

test('P413 claims are read in order', () => {
  const entity = { claims: { P413: [
    { mainsnak: { datavalue: { value: { id: 'Q1' } } } },
    { mainsnak: { datavalue: { value: { id: 'Q2' } } } },
    { mainsnak: {} },
  ] } };
  assert.deepEqual(positionIdsFromEntity(entity), ['Q1', 'Q2']);
  assert.deepEqual(positionIdsFromEntity({}), []);
  assert.deepEqual(positionIdsFromEntity({ claims: {} }), []);
});

// ---------------------------------------------------------------------------
// Club: P54 is a career history, not a field
// ---------------------------------------------------------------------------

test('the current club is the statement with no end date', async () => {
  const { currentTeamId } = await import('../src/media/players.js');
  const entity = { claims: { P54: [
    { rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q-old' } } },
      qualifiers: { P582: [{ datavalue: { value: { time: '+2019-06-30' } } }] } },
    { rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q-now' } } } },
  ] } };
  assert.equal(currentTeamId(entity), 'Q-now');
});

test('a career with no open statement yields no club', async () => {
  const { currentTeamId } = await import('../src/media/players.js');
  assert.equal(currentTeamId({ claims: { P54: [
    { mainsnak: { datavalue: { value: { id: 'Q1' } } },
      qualifiers: { P582: [{ datavalue: { value: { time: '+2024-06-30' } } }] } },
  ] } }), null);
  assert.equal(currentTeamId({}), null);
  assert.equal(currentTeamId({ claims: { P54: [] } }), null);
});

test('two open statements yield no club rather than a coin flip', async () => {
  const { currentTeamId } = await import('../src/media/players.js');
  // Overlapping loans, or a mid-edit Wikidata page. Showing one of them is how a club
  // filter ends up quietly wrong; showing none is honest and recoverable.
  assert.equal(currentTeamId({ claims: { P54: [
    { rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q1' } } } },
    { rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q2' } } } },
  ] } }), null);
});

test('a preferred open statement wins over a merely normal one', async () => {
  const { currentTeamId } = await import('../src/media/players.js');
  assert.equal(currentTeamId({ claims: { P54: [
    { rank: 'normal',    mainsnak: { datavalue: { value: { id: 'Q-loan' } } } },
    { rank: 'preferred', mainsnak: { datavalue: { value: { id: 'Q-parent' } } } },
  ] } }), 'Q-parent');
});

test('deprecated statements are ignored even when open', async () => {
  const { currentTeamId } = await import('../src/media/players.js');
  assert.equal(currentTeamId({ claims: { P54: [
    { rank: 'deprecated', mainsnak: { datavalue: { value: { id: 'Q-bad' } } } },
    { rank: 'normal',     mainsnak: { datavalue: { value: { id: 'Q-good' } } } },
  ] } }), 'Q-good');
});
