import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const format = loadTs(new URL('../src/format/index.ts', import.meta.url), {});
const { normalizeEntities, toggleEntity, shiftEntities, validEntities, maskSpoilers, activeTypes, clearFormatting, sliceEntities, snapToCodePoint, packEntities } = format;

test('offsets count UTF-16 code units: an emoji takes two', () => {
  const text = '😀 bold';
  assert.equal(text.length, 7);
  const entities = toggleEntity([], text, { start: 3, end: 7 }, 'bold');
  assert.deepEqual(entities, [{ type: 'bold', offset: 3, length: 4 }]);
  assert.equal(text.slice(3, 7), 'bold');
});

test('a range never cuts a surrogate pair in half', () => {
  const text = 'a😀b';
  assert.equal(snapToCodePoint(text, 2), 1);
  assert.deepEqual(normalizeEntities([{ type: 'bold', offset: 2, length: 1 }], text), [{ type: 'bold', offset: 1, length: 2 }]);
  assert.deepEqual(toggleEntity([], text, { start: 0, end: 2 }, 'italic'), [{ type: 'italic', offset: 0, length: 3 }]);
});

test('toggle adds, merges and removes; a partial overlap extends instead of removing', () => {
  const text = 'hello world';
  let entities = toggleEntity([], text, { start: 0, end: 5 }, 'bold');
  entities = toggleEntity(entities, text, { start: 5, end: 11 }, 'bold');
  assert.deepEqual(entities, [{ type: 'bold', offset: 0, length: 11 }]);
  entities = toggleEntity(entities, text, { start: 6, end: 11 }, 'bold');
  assert.deepEqual(entities, [{ type: 'bold', offset: 0, length: 6 }]);
  entities = toggleEntity(entities, text, { start: 3, end: 8 }, 'bold');
  assert.deepEqual(entities, [{ type: 'bold', offset: 0, length: 8 }]);
  // Removing from the middle splits the entity.
  entities = toggleEntity(entities, text, { start: 2, end: 4 }, 'bold');
  assert.deepEqual(entities, [{ type: 'bold', offset: 0, length: 2 }, { type: 'bold', offset: 4, length: 4 }]);
});

test('quote and code blocks take whole lines and exclude each other', () => {
  const text = 'first line\nsecond line\nthird';
  let entities = toggleEntity([], text, { start: 13, end: 15 }, 'quote');
  assert.deepEqual(entities, [{ type: 'quote', offset: 11, length: 11 }]);
  entities = toggleEntity(entities, text, { start: 12, end: 12 }, 'pre');
  assert.deepEqual(entities, [{ type: 'pre', offset: 11, length: 11 }]);
  // Monospace drops the decorations it cannot show.
  const mixed = toggleEntity([{ type: 'bold', offset: 0, length: 5 }], text, { start: 0, end: 5 }, 'code');
  assert.deepEqual(mixed, [{ type: 'code', offset: 0, length: 5 }]);
});

test('a link needs an http(s) url and replaces the previous link in the range', () => {
  const text = 'see docs';
  assert.deepEqual(toggleEntity([], text, { start: 4, end: 8 }, 'text_link', 'javascript:alert(1)'), []);
  const first = toggleEntity([], text, { start: 4, end: 8 }, 'text_link', 'https://a.example');
  const second = toggleEntity(first, text, { start: 4, end: 8 }, 'text_link', 'https://b.example');
  assert.deepEqual(second, [{ type: 'text_link', offset: 4, length: 4, url: 'https://b.example' }]);
  assert.deepEqual(toggleEntity(second, text, { start: 4, end: 8 }, 'text_link'), []);
});

test('typing moves entities: before, inside, after and across an emoji', () => {
  const entities = [{ type: 'bold', offset: 4, length: 4 }]; // "bold" in "abc bold xyz"
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc😀 bold xyz'), [{ type: 'bold', offset: 6, length: 4 }]);
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc boXXld xyz'), [{ type: 'bold', offset: 4, length: 6 }]);
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc bold xyz!!'), [{ type: 'bold', offset: 4, length: 4 }]);
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc  xyz'), []);
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', ''), []);
  // Deleting part of the range shrinks it.
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc bld xyz'), [{ type: 'bold', offset: 4, length: 3 }]);
});

test('validEntities accepts the Telegram shape and rejects everything else', () => {
  assert.ok(validEntities([{ type: 'bold', offset: 0, length: 3 }], 3));
  assert.ok(validEntities([{ type: 'text_link', offset: 0, length: 3, url: 'https://x.y' }], 3));
  assert.ok(validEntities([{ type: 'pre', offset: 0, length: 3, language: 'js' }], 3));
  assert.ok(!validEntities([{ type: 'bold', offset: 0, length: 4 }], 3));
  assert.ok(!validEntities([{ type: 'bold', offset: 0, length: 0 }], 3));
  assert.ok(!validEntities([{ type: 'bold', offset: 1.5, length: 1 }], 3));
  assert.ok(!validEntities([{ type: 'text_link', offset: 0, length: 3 }], 3));
  assert.ok(!validEntities([{ type: 'text_link', offset: 0, length: 3, url: 'ftp://x' }], 3));
  assert.ok(!validEntities([{ type: 'bold', offset: 0, length: 3, url: 'https://x.y' }], 3));
  assert.ok(!validEntities([{ type: 'bold', offset: 0, length: 3, language: 'js' }], 3));
  assert.ok(!validEntities([{ type: 'blink', offset: 0, length: 3 }], 3));
  assert.ok(!validEntities([{ type: 'bold', offset: 0, length: 3, extra: 1 }], 3));
  assert.ok(!validEntities(Array.from({ length: 101 }, () => ({ type: 'bold', offset: 0, length: 1 })), 3));
  assert.ok(!validEntities({}, 3));
});

test('spoilers are masked in previews, everything else stays plain', () => {
  const text = 'Финал: 😱 Джон умер, вот так';
  const entities = [{ type: 'spoiler', offset: 10, length: 9 }, { type: 'bold', offset: 0, length: 5 }];
  assert.equal(text.slice(10, 19), 'Джон умер');
  assert.equal(maskSpoilers(text, entities), 'Финал: 😱 ▒▒▒▒▒▒▒▒, вот так');
  assert.equal(maskSpoilers(text, []), text);
  assert.equal(maskSpoilers(text, undefined), text);
});

test('activeTypes, clearFormatting and sliceEntities', () => {
  const text = 'ab cd ef';
  const entities = [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 3, length: 5 }];
  assert.deepEqual([...activeTypes(entities, { start: 3, end: 5 })].sort(), ['bold', 'italic']);
  assert.deepEqual([...activeTypes(entities, { start: 0, end: 8 })], []);
  assert.deepEqual([...activeTypes(entities, { start: 1, end: 1 })], ['bold']);
  assert.deepEqual(clearFormatting(entities, text, { start: 3, end: 5 }), [{ type: 'bold', offset: 0, length: 3 }, { type: 'italic', offset: 5, length: 3 }]);
  assert.deepEqual(sliceEntities(entities, text, { start: 3, end: 8 }), [{ type: 'italic', offset: 0, length: 5 }, { type: 'bold', offset: 0, length: 2 }]); // longer first at one offset
  assert.equal(packEntities([], text), undefined);
  assert.equal(packEntities([{ type: 'bold', offset: 20, length: 3 }], text), undefined);
});

test('typing right before a range pushes it along; typing right after does not grow it (symmetric edges)', () => {
  const entities = [{ type: 'bold', offset: 4, length: 4 }]; // "bold" in "abc bold xyz"
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc Xbold xyz'), [{ type: 'bold', offset: 5, length: 4 }]);
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc boldX xyz'), [{ type: 'bold', offset: 4, length: 4 }]);
  // Replacing a selection that starts at the range start keeps the new text inside the range.
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abc Xld xyz'), [{ type: 'bold', offset: 4, length: 3 }]);
  // Deleting the character right before the range moves it back without shrinking it.
  assert.deepEqual(shiftEntities(entities, 'abc bold xyz', 'abcbold xyz'), [{ type: 'bold', offset: 3, length: 4 }]);
});

test('snapping never cuts a grapheme: ZWJ sequences, VS16, keycaps, skin tones and flags stay whole', () => {
  const { snapEnd } = format;
  const family = '👨‍👩‍👧'; // 1F468 200D 1F469 200D 1F467 → 8 code units
  assert.equal(family.length, 8);
  for (const at of [1, 2, 3, 4, 5, 6, 7]) { assert.equal(snapToCodePoint(family, at), 0, `start ${at}`); assert.equal(snapEnd(family, at), 8, `end ${at}`); }
  assert.deepEqual(normalizeEntities([{ type: 'bold', offset: 2, length: 3 }], family), [{ type: 'bold', offset: 0, length: 8 }]);
  const heart = 'a❤️b'; // 2764 FE0F
  assert.equal(snapToCodePoint(heart, 2), 1); assert.equal(snapEnd(heart, 2), 3); assert.equal(snapToCodePoint(heart, 3), 3);
  const thumb = 'a👍🏽b'; // 1F44D 1F3FD → 4 code units
  assert.equal(snapToCodePoint(thumb, 3), 1); assert.equal(snapEnd(thumb, 3), 5); assert.equal(snapEnd(thumb, 2), 5);
  const keycap = '1️⃣x'; // 31 FE0F 20E3
  assert.equal(snapToCodePoint(keycap, 2), 0); assert.equal(snapEnd(keycap, 1), 3); assert.equal(snapToCodePoint(keycap, 3), 3);
  const flags = '🇷🇺🇺🇸'; // two flags of two regional indicators each
  assert.equal(snapToCodePoint(flags, 2), 0); assert.equal(snapEnd(flags, 2), 4);
  assert.equal(snapToCodePoint(flags, 4), 4, 'the boundary between two flags is a real boundary');
  assert.equal(snapToCodePoint(flags, 6), 4); assert.equal(snapEnd(flags, 6), 8);
  assert.deepEqual(toggleEntity([], flags, { start: 1, end: 5 }, 'bold'), [{ type: 'bold', offset: 0, length: 8 }]);
  // Plain text and the ends are untouched.
  assert.equal(snapToCodePoint('abc', 2), 2); assert.equal(snapEnd('abc', 2), 2); assert.equal(snapEnd('abc', 9), 3);
});

test('a link whose text is not its address needs a confirmation', () => {
  const { linkTextMatchesUrl } = format;
  assert.ok(linkTextMatchesUrl('https://example.org/docs', 'https://example.org/docs'));
  assert.ok(linkTextMatchesUrl('example.org/docs/', 'https://www.example.org/docs'));
  assert.ok(linkTextMatchesUrl('Example.org', 'https://example.org'));
  assert.ok(!linkTextMatchesUrl('подробнее', 'https://evil.example'));
  assert.ok(!linkTextMatchesUrl('https://bank.example', 'https://bank.example.evil.tld'));
  assert.ok(!linkTextMatchesUrl('', 'https://example.org'));
});
