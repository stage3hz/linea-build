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

test('birthday reminders: day before 10:00 and 20:00, the day 00:00 and 10:00; today / next / 29 Feb', () => {
  const now = new Date(2026, 10, 6, 12, 0); // 6 Nov 2026, 12:00
  assert.equal(b.isBirthdayToday('11-06', now), true);
  assert.equal(b.isBirthdayToday('1990-11-07', now), false);
  assert.equal(b.isBirthdayToday('02-29', new Date(2027, 1, 28)), true);
  assert.deepEqual(b.nextBirthday('11-06', now), new Date(2026, 10, 6));
  assert.deepEqual(b.nextBirthday('11-05', now), new Date(2027, 10, 5));
  const r = b.birthdayReminders('Иван', '11-07', now).map(x => [x.at.getDate(), x.at.getHours(), x.when]);
  assert.deepEqual(r, [[6, 20, 'tomorrow'], [7, 0, 'today'], [7, 10, 'today']]);
  assert.equal(b.birthdayReminders('Иван', '11-20', now).length, 4);
  assert.equal(b.birthdayReminders('Иван', '11-20', now)[0].title, '🎂 Иван: завтра день рождения');
});
