import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryFor, searchLinks, groupedSearchLinks, MELBOURNE } from '../src/search/links.js';

const MORA = {
  player: 'Gilberto Mora', section: 'Base', cardNumber: '214', productCode: 'A',
  parallelName: 'Teal (#/199)', printRun: 199, team: 'Mexico',
};

test('the short query stays short, because marketplace search is token matching', () => {
  const q = queryFor(MORA);
  // "2025-26 Donruss Road to World Cup Gilberto Mora #214 Rated Rookie Teal /199" matches
  // no listing anyone ever wrote. Player plus the distinguishing tokens does.
  assert.ok(q.split(' ').length <= 5, `too long: ${q}`);
  assert.match(q, /Gilberto Mora/);
  assert.match(q, /Teal/);
  assert.match(q, /\/199/);
  assert.ok(!/Donruss/.test(q), 'product name belongs only in the verbose query');
  // Parenthetical print runs are noise in a search box.
  assert.ok(!/\(/.test(q), q);
});

test('the verbose query adds the set and the card number', () => {
  const q = queryFor(MORA, { verbose: true });
  assert.match(q, /#214/);
  assert.match(q, /Donruss Road to World Cup/);
});

test('a plain base card does not get "Base" bolted onto the search', () => {
  const q = queryFor({ player: 'Someone', section: 'Base' });
  assert.equal(q, 'Someone');
  assert.equal(queryFor({ player: 'Someone', section: 'Base Optic' }), 'Someone');
});

test('a grade is part of the query, since it is a different market', () => {
  assert.match(queryFor({ player: 'Lionel Messi', grader: 'PSA', grade: 10 }), /PSA 10/);
});

test('every eBay link asks for SOLD and COMPLETED', () => {
  // Without both parameters you are reading asking prices, which is the most common way a
  // collector talks themselves into a valuation.
  for (const l of searchLinks(MORA).filter((x) => /ebay/.test(x.channel))) {
    assert.match(l.url, /LH_Sold=1/, l.channel);
    assert.match(l.url, /LH_Complete=1/, l.channel);
  }
});

test('local links are centred on the configured city', () => {
  const links = searchLinks(MORA, MELBOURNE);
  const fb = links.find((l) => l.channel === 'facebook_marketplace')!;
  assert.match(fb.url, new RegExp(MELBOURNE.fbPlaceId));
  assert.match(fb.url, /radius_km=60/);
  const gum = links.find((l) => l.channel === 'gumtree')!;
  assert.match(gum.url, new RegExp(MELBOURNE.gumtreeSlug));
});

test('every link is a real absolute URL with the query encoded', () => {
  for (const l of searchLinks(MORA)) {
    const u = new URL(l.url);                       // throws if malformed
    assert.match(u.protocol, /^https:$/, l.channel);
    assert.ok(!/ /.test(l.url), `unencoded space in ${l.channel}`);
    assert.ok(l.note.length > 20, `${l.channel} needs a note saying what you actually get`);
  }
});

test('channels that only show asking prices say so', () => {
  // The honesty requirement: a link that looks like a price source but is not must admit
  // it in the note, because that is the one thing a user could get badly wrong.
  const asking = ['facebook_marketplace', 'facebook_groups', 'gumtree', 'xianyu'];
  for (const ch of asking) {
    const l = searchLinks(MORA).find((x) => x.channel === ch)!;
    assert.match(l.note, /asking|no sold|reconnaissance|record what/i, ch);
  }
});

test('Trends links carry the normalisation caveat', () => {
  for (const l of searchLinks(MORA).filter((x) => /trends/.test(x.channel))) {
    assert.match(l.note, /normalised|not demand|not evidence|sanity check/i, l.channel);
  }
});

test('grouping covers every link and leads with sold prices', () => {
  const groups = groupedSearchLinks(MORA);
  assert.equal(groups[0]!.group, 'sold', 'sold prices first, not the local links');
  const flat = groups.flatMap((g) => g.links);
  assert.equal(flat.length, searchLinks(MORA).length);
  assert.equal(new Set(flat.map((l) => l.channel)).size, flat.length, 'no duplicate channels');
});
