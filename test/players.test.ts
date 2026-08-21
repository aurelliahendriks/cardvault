import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanMeta, evaluateLicense, firstHref, imageFilenameFromEntity,
  parseCommonsImageinfo, pickFootballer,
} from '../src/media/players.ts';

/**
 * Fixtures mirror the real shapes returned by the Wikidata and Commons APIs.
 * The network is unreachable from the build sandbox, so the HTTP call itself is
 * unverified — but every decision made on the response is covered here, and the
 * decisions are where the damage happens: a wrong face on a card, or an image used
 * without the attribution its licence demands.
 */

const FOOTBALLER = {
  Q3436649: {
    labels: { en: { value: 'Lamine Yamal' } },
    claims: {
      P106: [{ mainsnak: { datavalue: { value: { id: 'Q937857' } } } }],
      P18: [{ mainsnak: { datavalue: { value: 'Lamine Yamal 2024.jpg' } } }],
    },
  },
};

const MUSICIAN = {
  Q999001: {
    labels: { en: { value: 'Lamine Yamal (musician)' } },
    claims: {
      P106: [{ mainsnak: { datavalue: { value: { id: 'Q639669' } } } }],  // musician
      P18: [{ mainsnak: { datavalue: { value: 'Someone else entirely.jpg' } } }],
    },
  },
};

test('picks the footballer, not a same-named musician', () => {
  const both = { ...MUSICIAN, ...FOOTBALLER };
  // Search order deliberately puts the musician first, as Wikidata sometimes does.
  const hit = pickFootballer(both, ['Q999001', 'Q3436649']);
  assert.equal(hit?.id, 'Q3436649');
  assert.equal(hit?.label, 'Lamine Yamal');
});

test('returns null when no candidate is a footballer', () => {
  assert.equal(pickFootballer(MUSICIAN, ['Q999001']), null);
});

test('tolerates entities with no occupation claim at all', () => {
  const bare = { Q1: { labels: { en: { value: 'X' } }, claims: {} } };
  assert.equal(pickFootballer(bare, ['Q1']), null);
});

test('extracts the P18 image filename', () => {
  assert.equal(imageFilenameFromEntity(FOOTBALLER.Q3436649), 'Lamine Yamal 2024.jpg');
  assert.equal(imageFilenameFromEntity({ claims: {} }), null);
});

test('strips HTML out of Commons metadata', () => {
  assert.equal(cleanMeta('<a href="/wiki/User:Bob" title="x">Bob&nbsp;Smith</a>'), 'Bob Smith');
  assert.equal(cleanMeta('Plain &amp; simple'), 'Plain & simple');
  assert.equal(cleanMeta(undefined), null);
  assert.equal(cleanMeta(''), null);
});

test('pulls the author link out of the metadata blob', () => {
  assert.equal(firstHref('<a href="//commons.wikimedia.org/wiki/User:Bob">Bob</a>'),
    'https://commons.wikimedia.org/wiki/User:Bob');
  assert.equal(firstHref('no link here'), null);
});

test('accepts free licences', () => {
  for (const l of ['CC BY-SA 4.0', 'CC BY 2.0', 'cc-by-sa-3.0', 'CC0', 'Public domain', 'No restrictions']) {
    assert.equal(evaluateLicense(l, null).ok, true, `should accept ${l}`);
  }
});

test('refuses non-free and unclear licences rather than guessing', () => {
  for (const l of ['Fair use', 'Non-free logo', 'All rights reserved', 'Copyrighted free use pending']) {
    assert.equal(evaluateLicense(l, null).ok, false, `should refuse ${l}`);
  }
  assert.equal(evaluateLicense(null, null).ok, false);
  assert.equal(evaluateLicense('', '').ok, false);
});

test('parses a well-formed Commons imageinfo response with full attribution', () => {
  const json = {
    query: { pages: { '123': {
      imageinfo: [{
        url: 'https://upload.wikimedia.org/x/Lamine.jpg',
        thumburl: 'https://upload.wikimedia.org/thumb/x/Lamine.jpg/320px-Lamine.jpg',
        thumbwidth: 320,
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lamine.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
          Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Photog">Photog</a>' },
        },
      }],
    } } },
  };
  const r = parseCommonsImageinfo(json);
  assert.equal(r.ok, true);
  assert.equal(r.thumbUrl, 'https://upload.wikimedia.org/thumb/x/Lamine.jpg/320px-Lamine.jpg');
  assert.equal(r.license, 'CC BY-SA 4.0');
  assert.equal(r.author, 'Photog');
  assert.equal(r.creditUrl, 'https://commons.wikimedia.org/wiki/File:Lamine.jpg');
  assert.equal(r.width, 320);
});

test('rejects an image whose licence is non-free, even with everything else present', () => {
  const json = {
    query: { pages: { '1': { imageinfo: [{
      url: 'u', thumburl: 't', descriptionurl: 'd',
      extmetadata: { LicenseShortName: { value: 'Fair use' }, Artist: { value: 'Someone' } },
    }] } } },
  };
  const r = parseCommonsImageinfo(json);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /licence not usable/);
});

test('rejects a response with no imageinfo', () => {
  assert.equal(parseCommonsImageinfo({ query: { pages: { '1': {} } } }).ok, false);
  assert.equal(parseCommonsImageinfo({}).ok, false);
});

test('falls back to the full URL when no thumbnail was generated', () => {
  const json = {
    query: { pages: { '1': { imageinfo: [{
      url: 'https://upload.wikimedia.org/full.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:full.jpg',
      extmetadata: { LicenseShortName: { value: 'CC0' } },
    }] } } },
  };
  const r = parseCommonsImageinfo(json);
  assert.equal(r.ok, true);
  assert.equal(r.thumbUrl, 'https://upload.wikimedia.org/full.jpg');
  assert.equal(r.author, 'Unknown');
});
