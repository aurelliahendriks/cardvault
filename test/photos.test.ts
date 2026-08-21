import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';

process.env.PHOTO_DIR ??= '/tmp/cv-photo-test';
const { slug, skuFolder, resolveInRoot, photoRoot, sniffMime } = await import('../src/photos.ts');

// ---------------------------------------------------------------------------
// Folder names
//
// These end up as real directories on a Windows disk. Windows is the strict one: `< > : " / \
// | ? *` are illegal, a name cannot end in a dot or a space, and CON/PRN/AUX/NUL/COM1-9/LPT1-9
// are reserved device names that fail in ways that look like a permissions problem rather than
// a naming one.
// ---------------------------------------------------------------------------

test('slug produces names that are legal on Windows', () => {
  const illegal = /[<>:"/\\|?*]/;
  for (const input of [
    'Prizm FIFA 25/26 · Base · #245 · Lamine Yamal · Pink Power (#/75)',
    'Kaboom! · "quoted" · a:b*c?d',
    'trailing dot.',
    'trailing space ',
    '../../etc/passwd',
    'C:\\Windows\\System32',
  ]) {
    const s = slug(input);
    assert.ok(!illegal.test(s), `${input} -> ${s} contains an illegal character`);
    assert.ok(!/[. ]$/.test(s), `${input} -> ${s} ends in a dot or space`);
    assert.ok(s.length > 0, `${input} -> empty`);
  }
});

test('slug avoids the Windows reserved device names', () => {
  // A folder called `CON` cannot be created on Windows at all, and the error says
  // "The system cannot find the file specified", which is a lie you can lose an hour to.
  for (const name of ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'LPT9']) {
    assert.notEqual(slug(name), name.toLowerCase(), `${name} was left as a reserved name`);
  }
  // But a name that merely contains one is fine.
  assert.equal(slug('Connor'), 'connor');
  assert.equal(slug('com10'), 'com10');
});

test('slug folds accents rather than dropping the letters', () => {
  // "Mbappé" must not become "mbapp" — the folder is meant to be recognisable.
  assert.equal(slug('Kylian Mbappé'), 'kylian-mbappe');
  assert.equal(slug('Anaïs Ökonomou'), 'anais-okonomou');
});

test('slug never returns an empty string', () => {
  // An empty folder name would silently write the photo into the parent directory, so two
  // different cards would overwrite each other.
  for (const junk of ['', '   ', '///', '...', '!!!']) {
    assert.equal(slug(junk), 'untitled', JSON.stringify(junk));
  }
});

test('the sku folder keeps the id, so two cards cannot share a directory', () => {
  // Long labels truncate, and two different cards can truncate to the same 60 characters.
  // Without the id the second card's photographs would land on top of the first's.
  const long = 'Panini Prizm FIFA 25/26 · Base · #245 · A Player With A Very Long Name Indeed';
  const a = skuFolder('ibi', 11, long + ' One');
  const b = skuFolder('ibi', 12, long + ' Two');
  assert.notEqual(a, b, 'two long labels collapsed into the same folder');
  assert.ok(a.endsWith('sku11'));
  assert.ok(b.endsWith('sku12'));
});

test('the sku folder is readable by a person', () => {
  const f = skuFolder('ibi', 1841, 'Prizm FIFA 25/26 · Base · #245 · Lamine Yamal · Pink Power (#/75) · Raw');
  assert.match(f, /^ibi[\\/]/, f);
  assert.match(f, /lamine-yamal/, f);
  assert.match(f, /245/, f);
  assert.match(f, /pink-power/, f);
  assert.ok(!/raw/.test(f), 'the word Raw is on every ungraded card and adds nothing');
});

// ---------------------------------------------------------------------------
// Containment
//
// The paths in the database are written by this module, so today they are all safe. This is
// the guard for tomorrow, when something else writes one.
// ---------------------------------------------------------------------------

test('a path that escapes the photo folder is refused', () => {
  for (const evil of [
    '../../etc/passwd',
    'ibi/../../outside.jpg',
    '/etc/shadow',
    'ibi/./../../x.jpg',
  ]) {
    assert.throws(() => resolveInRoot(evil), /escapes|relative/, evil);
  }
});

test('backslash traversal is refused even though Linux would allow it as a filename', () => {
  // This is the case that got through the first version. The app runs on Linux inside the
  // container, where `..\..\windows\system32` is ONE legal filename and `path.resolve` reports
  // it as safely inside the root. The folder it writes to is a Windows bind mount, where the
  // same string is four levels of traversal. A guard whose answer depends on which side of
  // the mount you ask is not a guard.
  assert.throws(() => resolveInRoot('..\\..\\windows\\system32\\config\\sam'), /escapes/);
  assert.throws(() => resolveInRoot('ibi\\..\\..\\x.jpg'), /escapes/);
  assert.throws(() => resolveInRoot('C:\\Windows\\x.jpg'), /relative/);
});

test('a sibling folder sharing the root prefix is refused', () => {
  // The classic off-by-one: `/data/photos-evil` startsWith `/data/photos`.
  assert.throws(() => resolveInRoot('../' + photoRoot().split('/').pop() + '-evil/x.jpg'), /escapes/);
});

test('an ordinary path resolves inside the root', () => {
  const p = resolveInRoot('ibi/lamine-yamal-sku9/front.jpg');
  assert.equal(p, resolve(photoRoot(), 'ibi/lamine-yamal-sku9/front.jpg'));
  assert.ok(p.startsWith(photoRoot()));
});

// ---------------------------------------------------------------------------
// What is actually an image
// ---------------------------------------------------------------------------

test('the mime sniffer reads the bytes, not the label', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
  assert.equal(sniffMime(png), 'image/png');
  assert.equal(sniffMime(jpeg), 'image/jpeg');
  // A Windows executable renamed to .jpg is the thing a file input will happily hand you.
  assert.equal(sniffMime(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00')), null);
  assert.equal(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null,
               'SVG is refused: it is a document that can carry script, not a photograph');
  assert.equal(sniffMime(Buffer.alloc(4)), null, 'too short to identify');
});
