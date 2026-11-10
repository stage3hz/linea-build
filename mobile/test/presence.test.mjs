import assert from 'node:assert/strict';
import test from 'node:test';
import { presenceText } from '../src/presence.ts';
import { lastSeenSummary, listsFor } from '../src/privacy/lastSeenModel.ts';

test('presence wording follows Telegram', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
  const at = ms => new Date(now - ms).toISOString();
  assert.equal(presenceText(undefined, now), null);
  assert.equal(presenceText({ userId: 'u', online: true, lastSeenAt: null, hidden: false }, now), 'в сети');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: null, hidden: true }, now), 'был(а) недавно');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: at(20_000), hidden: false }, now), 'был(а) только что');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: at(5 * 60_000), hidden: false }, now), 'был(а) 5 минут назад');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: at(21 * 60_000), hidden: false }, now), 'был(а) 21 минуту назад');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: at(2 * 3_600_000), hidden: false }, now), 'был(а) 2 часа назад');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: new Date(2026, 9, 30, 3, 5).toISOString(), hidden: false }, now), 'был(а) сегодня в 03:05');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: new Date(2026, 9, 29, 21, 4).toISOString(), hidden: false }, now), 'был(а) вчера в 21:04');
  assert.equal(presenceText({ userId: 'u', online: false, lastSeenAt: new Date(2026, 9, 2, 9, 0).toISOString(), hidden: false }, now), 'был(а) 02.10.26');
});

test('hidden «last seen»: Telegram\'s approximate wording, never a time, online hidden too', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
  const hidden = approx => ({ userId: 'u', online: false, lastSeenAt: null, hidden: true, approx });
  assert.equal(presenceText(hidden('recently'), now), 'был(а) недавно');
  assert.equal(presenceText(hidden('week'), now), 'был(а) на этой неделе');
  assert.equal(presenceText(hidden('month'), now), 'был(а) в этом месяце');
  assert.equal(presenceText(hidden('long'), now), 'был(а) давно');
  assert.equal(presenceText(hidden(undefined), now), 'был(а) недавно', 'an older server sends no bucket');
  assert.equal(presenceText(hidden('bogus'), now), 'был(а) недавно');
  // Even a packet that (wrongly) says online and has a time shows only the bucket once it is hidden.
  assert.equal(presenceText({ userId: 'u', online: true, lastSeenAt: new Date(now - 60_000).toISOString(), hidden: true, approx: 'week' }, now), 'был(а) на этой неделе');
});

test('«Время захода» row: mode name and Telegram-style exception counts for the lists that apply', () => {
  const rules = { allow: [1, 2], deny: [1] };
  assert.deepEqual(listsFor('everyone'), { allow: false, deny: true });
  assert.deepEqual(listsFor('contacts'), { allow: true, deny: true });
  assert.deepEqual(listsFor('nobody'), { allow: true, deny: false });
  assert.equal(lastSeenSummary('everyone', null), 'Все');
  assert.equal(lastSeenSummary('everyone', { allow: [], deny: [] }), 'Все');
  assert.equal(lastSeenSummary('everyone', rules), 'Все (−1)');
  assert.equal(lastSeenSummary('contacts', rules), 'Мои друзья (−1, +2)');
  assert.equal(lastSeenSummary('nobody', rules), 'Никто (+2)');
  assert.equal(lastSeenSummary('nobody', rules, text => ({ 'Никто': 'Nobody' })[text] || text), 'Nobody (+2)');
});
