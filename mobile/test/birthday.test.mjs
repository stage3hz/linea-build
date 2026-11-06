import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const b = loadTs(new URL('../src/birthday.ts', import.meta.url));
test('birthday: «2 мар» / «2 мар 1999», MM-DD and YYYY-MM-DD round trip, month lengths', () => {
  assert.equal(b.formatBirthday('03-02'), '2 мар');
  assert.equal(b.formatBirthday('1999-03-02'), '2 мар 1999');
  assert.equal(b.formatBirthday(null), '');
  assert.equal(b.birthdayValue(b.parseBirthday('1999-12-31')), '1999-12-31');
  assert.equal(b.birthdayValue({ day: 2, month: 3, year: null }), '03-02');
  assert.equal(b.daysInMonth(2, null), 29);
  assert.equal(b.daysInMonth(2, 2001), 28);
  assert.equal(b.daysInMonth(4, 2001), 30);
});
