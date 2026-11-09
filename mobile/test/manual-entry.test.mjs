import assert from 'node:assert/strict';
import test from 'node:test';
import { isManualEdit } from '../src/auth/manualEdit.ts';

const cases = [
  ['unchanged text', 'abc', 'abc', true],
  ['Latin key', '', 'a', true],
  ['Russian key', 'корабл', 'корабль', true],
  ['one supplementary Unicode code point', 'x', 'x😀', true],
  ['backspace removes a complete emoji', 'x😀', 'x', true],
  ['deleting a selected range', 'длинноеслово', 'длиово', true],
  ['replacing a selection with one character', 'abcdef', 'abЖf', true],
  ['pasting a word into an empty field', '', 'корабль', false],
  ['inserting a two-character suffix', 'кораб', 'корабль', false],
  ['autofill replaces an existing value', 'old', 'newpassword', false],
  ['input method inserts a complete word', '', 'астра', false],
  ['one grapheme containing multiple code points', 'x', 'x👩‍💻', false],
  ['typing a combining mark separately', 'е', 'е\u0308', true],
  ['deleting the complete value', 'word', '', true],
];
for (const [name, previous, next, expected] of cases) {
  test(name, () => assert.equal(isManualEdit(previous, next), expected));
}

test('text-change events alone cannot distinguish a one-character paste', () => {
  // Explicit web paste events are prevented by ManualField; the native event
  // contains only the resulting text, so the product makes no stronger claim.
  assert.equal(isManualEdit('', 'a'), true);
});

test('typed burst: characters merged into one change by a busy app pass when each came with a key press', () => {
  assert.equal(isManualEdit('s', 'simt', 3), true, 'three key presses, three characters');
  assert.equal(isManualEdit('', 'simtester1', 10), true);
  assert.equal(isManualEdit('s', 'simt', 2), false, 'more characters than key presses: something was pasted');
});

test('a paste or autofill (no key press) is still refused, also right after typing', () => {
  assert.equal(isManualEdit('s', 'simtester1', 0), false);
  assert.equal(isManualEdit('', 'correct horse battery staple', 0), false);
  assert.equal(isManualEdit('ab', 'abc', 0), true, 'one character is always allowed (a single key press may come without the event)');
});
