// F2 «Уведомления и звуки»: the mute model (until, labels, expiry by comparison) and the local preferences store.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const model = loadTs(new URL('../src/notifications/model.ts', import.meta.url));
// A fixed local «now»: Tuesday 10 March 2026, 12:00 local time.
const NOW = new Date(2026, 2, 10, 12, 0, 0).getTime();
const HOUR = 3600_000, DAY = 24 * HOUR;

test('the sheet choices: 1 hour, 8 hours, 2 days from now; «Навсегда» has no end', () => {
  assert.equal(model.muteUntil('1h', NOW), new Date(NOW + HOUR).toISOString());
  assert.equal(model.muteUntil('8h', NOW), new Date(NOW + 8 * HOUR).toISOString());
  assert.equal(model.muteUntil('2d', NOW), new Date(NOW + 2 * DAY).toISOString());
  assert.equal(model.muteUntil('forever', NOW), null);
  assert.deepEqual(model.MUTE_CHOICES.map(item => item.label), ['На 1 час', 'На 8 часов', 'На 2 дня', 'Навсегда']);
});

test('«Настроить…»: days + hours + minutes, nothing for zero, nothing past a year', () => {
  assert.equal(model.customMuteUntil({ days: 0, hours: 0, minutes: 45 }, NOW), new Date(NOW + 45 * 60_000).toISOString());
  assert.equal(model.customMuteUntil({ days: 2, hours: 3, minutes: 0 }, NOW), new Date(NOW + 2 * DAY + 3 * HOUR).toISOString());
  assert.equal(model.customMuteUntil({ days: 0, hours: 0, minutes: 0 }, NOW), null, 'nothing picked');
  assert.equal(model.customMuteUntil({ days: 366, hours: 0, minutes: 0 }, NOW), null, 'the server would refuse it');
  assert.equal(model.customMuteUntil({ days: 365, hours: 0, minutes: 0 }, NOW), new Date(NOW + 365 * DAY).toISOString());
  assert.equal(model.durationLabel({ days: 2, hours: 3, minutes: 0 }), '2 дня 3 часа');
  assert.equal(model.durationLabel({ days: 1, hours: 21, minutes: 1 }), '1 день 21 час 1 минута');
  assert.equal(model.durationLabel({ days: 5, hours: 0, minutes: 45 }), '5 дней 45 минут');
  assert.equal(model.durationLabel({ days: 0, hours: 0, minutes: 0 }), '');
});

test('labels like Telegram: «до 18:30», «до завтра, 09:15», «до 12 марта, 09:15», «навсегда»', () => {
  assert.equal(model.muteUntilLabel(new Date(2026, 2, 10, 18, 30).toISOString(), NOW), 'до 18:30');
  assert.equal(model.muteUntilLabel(new Date(2026, 2, 11, 9, 15).toISOString(), NOW), 'до завтра, 09:15');
  assert.equal(model.muteUntilLabel(new Date(2026, 2, 12, 9, 15).toISOString(), NOW), 'до 12 марта, 09:15');
  assert.equal(model.muteUntilLabel(new Date(2027, 0, 3, 9, 15).toISOString(), NOW), 'до 3 января 2027, 09:15', 'another year names it');
  assert.equal(model.muteUntilLabel(null, NOW), 'навсегда');
  assert.equal(model.muteUntilLabel(undefined, NOW), 'навсегда');
  assert.equal(model.muteUntilLabel('garbage', NOW), 'навсегда', 'an unreadable end is treated as no end');
  // Midnight edges: 23:59 today is still «до 23:59», 00:05 is «до завтра, 00:05».
  const late = new Date(2026, 2, 10, 23, 59).getTime();
  assert.equal(model.muteUntilLabel(new Date(2026, 2, 10, 23, 59).toISOString(), late - 60_000), 'до 23:59');
  assert.equal(model.muteUntilLabel(new Date(2026, 2, 11, 0, 5).toISOString(), late), 'до завтра, 00:05');
});

test('a mute ends by comparison: the list line and the icon switch before any refresh', () => {
  const until = new Date(NOW + HOUR).toISOString();
  assert.equal(model.isMuted({ muted: true, mutedUntil: until }, NOW), true);
  assert.equal(model.isMuted({ muted: true, mutedUntil: until }, NOW + HOUR - 1), true);
  assert.equal(model.isMuted({ muted: true, mutedUntil: until }, NOW + HOUR), false, 'the very moment it ends');
  assert.equal(model.isMuted({ muted: true }, NOW + 1000 * DAY), true, 'forever');
  assert.equal(model.isMuted({ muted: false, mutedUntil: until }, NOW), false, 'the flag rules');
  assert.equal(model.isMuted(undefined, NOW), false);
  assert.equal(model.isMuted(null, NOW), false);
  assert.equal(model.mutedStatusText({ muted: true, mutedUntil: new Date(2026, 2, 10, 18, 30).toISOString() }, NOW), 'Звук выключен до 18:30');
  assert.equal(model.mutedStatusText({ muted: true }, NOW), 'Звук выключен');
  assert.equal(model.mutedStatusText({ muted: true, mutedUntil: until }, NOW + 2 * HOUR), '', 'expired: nothing to say');
  assert.equal(model.mutedStatusText({ muted: false }, NOW), '');
});

test('preferences: defaults, tolerant parsing, one-level merge, «changed» detection', () => {
  const d = model.DEFAULT_NOTIFICATION_PREFS;
  assert.deepEqual(d, { chats: { show: true, sound: true, vibration: true, preview: true }, communities: { show: true, sound: true, vibration: true }, calls: { ringtone: 'neon', vibration: true }, badge: { enabled: true, countMuted: false } });
  assert.deepEqual(model.parseNotificationPrefs(null), d);
  assert.deepEqual(model.parseNotificationPrefs('not json'), d);
  assert.deepEqual(model.parseNotificationPrefs('[]'), d);
  const parsed = model.parseNotificationPrefs(JSON.stringify({ chats: { sound: false, preview: 'yes' }, calls: { ringtone: 'disco' }, badge: { countMuted: true } }));
  assert.deepEqual(parsed, { chats: { show: true, sound: false, vibration: true, preview: true }, communities: { show: true, sound: true, vibration: true }, calls: { ringtone: 'neon', vibration: true }, badge: { enabled: true, countMuted: true } });
  const merged = model.mergeNotificationPrefs(d, { chats: { vibration: false }, calls: { ringtone: 'pulse' } });
  assert.deepEqual(merged.chats, { show: true, sound: true, vibration: false, preview: true });
  assert.deepEqual(merged.calls, { ringtone: 'pulse', vibration: true });
  assert.deepEqual(merged.badge, d.badge);
  assert.equal(model.notificationPrefsChanged(d), false);
  assert.equal(model.notificationPrefsChanged(merged), true);
  assert.deepEqual(model.RINGTONES.map(item => item.label), ['Неон', 'Пульс', 'Без мелодии']);
});

test('the store saves every change, reads it back on the next start and forgets it on reset', async () => {
  const values = new Map();
  const storage = { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } };
  const open = () => loadTs(new URL('../src/notifications/prefs.ts', import.meta.url), { '@react-native-async-storage/async-storage': { __esModule: true, default: storage }, react: { useSyncExternalStore: () => null } });
  const first = open();
  assert.equal(first.getNotificationPrefs().chats.sound, true);
  first.setNotificationPrefs({ chats: { sound: false }, badge: { countMuted: true } });
  assert.equal(first.getNotificationPrefs().chats.sound, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(values.has('linea.notification-prefs.v1'));
  const second = open();
  await second.loadNotificationPrefs();
  assert.equal(second.getNotificationPrefs().chats.sound, false);
  assert.equal(second.getNotificationPrefs().badge.countMuted, true);
  assert.equal(second.getNotificationPrefs().communities.show, true, 'untouched groups keep their defaults');
  second.resetNotificationPrefs();
  assert.deepEqual(second.getNotificationPrefs(), model.DEFAULT_NOTIFICATION_PREFS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.has('linea.notification-prefs.v1'), false, 'reset removes the record');
});
