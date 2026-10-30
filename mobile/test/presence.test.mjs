import assert from 'node:assert/strict';
import test from 'node:test';
import { presenceText } from '../src/presence.ts';

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
