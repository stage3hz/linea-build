import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { nativeText, NATIVE_FMT: F } = loadTs(new URL('../src/format/nativeSpans.ts', import.meta.url), {});

test('plain text goes out untouched, with no runs', () => {
  assert.deepEqual(nativeText('Привет, как дела?'), { text: 'Привет, как дела?', fmt: [], urls: [] });
  assert.deepEqual(nativeText(''), { text: '', fmt: [], urls: [] });
});

test('inline entities become runs with UTF-16 offsets', () => {
  const result = nativeText('жирный курсив 😀 код', [
    { type: 'bold', offset: 0, length: 6 }, { type: 'italic', offset: 7, length: 6 }, { type: 'code', offset: 17, length: 3 },
  ]);
  assert.equal(result.text, 'жирный курсив 😀 код');
  assert.deepEqual(result.fmt, [F.bold, 0, 6, F.italic, 7, 6, F.mono, 17, 3]);
  assert.equal(result.text.slice(17, 20), 'код');
});

test('overlapping entities are cut into runs that carry every flag', () => {
  const result = nativeText('абвгде', [{ type: 'bold', offset: 0, length: 4 }, { type: 'spoiler', offset: 2, length: 4 }]);
  assert.deepEqual(result.fmt, [F.bold, 0, 2, F.bold | F.spoiler, 2, 2, F.spoiler, 4, 2]);
});

test('addresses and mentions are links; a hidden address keeps its own url', () => {
  const plain = nativeText('смотри www.example.com и @dimas');
  assert.deepEqual(plain.fmt, [F.link, 7, 15, F.link, 25, 6]);
  assert.deepEqual(plain.urls, ['https://www.example.com', 'mention:dimas']);
  const hidden = nativeText('подробнее тут', [{ type: 'text_link', offset: 0, length: 9, url: 'https://example.com/a' }]);
  assert.deepEqual(hidden.fmt, [F.link, 0, 9]);
  assert.deepEqual(hidden.urls, ['https://example.com/a']);
});

test('only http(s) is ever a link, and code is never linked', () => {
  const unsafe = nativeText('жми', [{ type: 'text_link', offset: 0, length: 3, url: 'javascript:alert(1)' }]);
  assert.deepEqual(unsafe.urls, []);
  const code = nativeText('https://a.example', [{ type: 'code', offset: 0, length: 17 }]);
  assert.deepEqual(code.fmt, [F.mono, 0, 17]);
  assert.deepEqual(code.urls, []);
});

test('quote and code blocks are runs with their block flag, one line break between blocks', () => {
  const result = nativeText('до\nцитата\nпосле', [{ type: 'quote', offset: 3, length: 6 }]);
  assert.equal(result.text, 'до\nцитата\nпосле');
  assert.deepEqual(result.fmt, [F.quote, 3, 6]);
  const pre = nativeText('let a = 1', [{ type: 'pre', offset: 0, length: 9 }]);
  assert.deepEqual(pre.fmt, [F.pre | F.mono, 0, 9]);
});

test('every run stays inside the text', () => {
  const result = nativeText('a **b** https://x.example/ @name', [{ type: 'bold', offset: 2, length: 5 }, { type: 'spoiler', offset: 0, length: 40 }]);
  for (let i = 0; i < result.fmt.length; i += 3) assert.ok(result.fmt[i + 1] >= 0 && result.fmt[i + 1] + result.fmt[i + 2] <= result.text.length);
  assert.equal(result.fmt.filter((_, i) => i % 3 === 0 && (result.fmt[i] & F.link)).length, result.urls.length);
});
