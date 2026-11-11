import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const s = loadTs(new URL('../src/calls/callStatus.ts', import.meta.url), {});
const base = { incoming: false, video: false, reconnecting: false, startedAt: null, endedText: '', network: 'online', now: 100_000 };

test('signalling network: phone offline → waiting, network but no server → connecting', () => {
  assert.equal(s.signalNetwork('connected', true), 'online');
  assert.equal(s.signalNetwork('connected', null), 'online');
  assert.equal(s.signalNetwork('connected', false), 'waiting', 'airplane mode before the socket notices');
  assert.equal(s.signalNetwork('offline', false), 'waiting');
  assert.equal(s.signalNetwork('offline', true), 'connecting');
  assert.equal(s.signalNetwork('connecting', null), 'connecting');
  assert.equal(s.signalNetwork('offline', null), 'waiting');
});

test('an outgoing call offline never says «Вызов…»', () => {
  assert.equal(s.callStatusText({ ...base, status: 'ringing' }), 'Вызов…');
  assert.equal(s.callStatusText({ ...base, status: 'requesting' }), 'Запрос…');
  assert.equal(s.callStatusText({ ...base, status: 'ringing', network: 'waiting' }), 'Ожидание сети…');
  assert.equal(s.callStatusText({ ...base, status: 'requesting', network: 'waiting' }), 'Ожидание сети…');
  assert.equal(s.callStatusText({ ...base, status: 'ringing', network: 'connecting' }), 'Соединение…');
  assert.equal(s.callStatusText({ ...base, status: 'connecting', network: 'waiting' }), 'Ожидание сети…');
  assert.equal(s.callStatusText({ ...base, status: 'connecting' }), 'Соединение…');
});

test('incoming, active, reconnecting and ended texts', () => {
  assert.equal(s.callStatusText({ ...base, status: 'incoming', incoming: true, video: true }), 'Входящий видеозвонок');
  assert.equal(s.callStatusText({ ...base, status: 'incoming', incoming: true, network: 'waiting' }), 'Входящий звонок');
  assert.equal(s.callStatusText({ ...base, status: 'active', startedAt: 58_000 }), '0:42');
  assert.equal(s.callStatusText({ ...base, status: 'active', startedAt: 58_000, reconnecting: true }), 'Восстановление связи…');
  assert.equal(s.callStatusText({ ...base, status: 'active', startedAt: 58_000, reconnecting: true, network: 'waiting' }), 'Ожидание сети…');
  assert.equal(s.callStatusText({ ...base, status: 'ended', endedText: 'Нет соединения' }), 'Нет соединения');
});

test('call bar: status plus the running clock while reconnecting; colour by state', () => {
  assert.deepEqual(s.callBarText({ ...base, status: 'active', startedAt: 58_000 }), { status: '0:42', clock: null });
  assert.deepEqual(s.callBarText({ ...base, status: 'active', startedAt: 58_000, reconnecting: true }), { status: 'Восстановление связи…', clock: '0:42' });
  assert.deepEqual(s.callBarText({ ...base, status: 'ringing', network: 'waiting' }), { status: 'Ожидание сети…', clock: null });
  assert.equal(s.callBarTone('active', false, 'online'), 'active');
  assert.equal(s.callBarTone('active', true, 'online'), 'trouble');
  assert.equal(s.callBarTone('ringing', false, 'online'), 'pending');
  assert.equal(s.callBarTone('ringing', false, 'waiting'), 'trouble');
  assert.equal(s.callBarTone('ended', false, 'online'), 'ended');
});

test('call bar sits under the status bar and pushes the content down by its height', () => {
  const h = s.CALL_BAR_HEIGHT;
  // App's SafeAreaView already starts the frame under the status bar / Dynamic Island (59 pt).
  assert.deepEqual(s.callBarLayout(59, 59), { top: 0, contentTop: h });
  // A frame that starts at the very top of the screen: the bar moves below the island instead of covering it.
  assert.deepEqual(s.callBarLayout(59, 0), { top: 59, contentTop: 59 + h });
  assert.deepEqual(s.callBarLayout(59, 20.4), { top: 39, contentTop: 39 + h });
  // Below the status bar (a desktop title bar above it) or not measured yet: no extra gap.
  assert.deepEqual(s.callBarLayout(0, 32), { top: 0, contentTop: h });
  assert.deepEqual(s.callBarLayout(59, null), { top: 0, contentTop: h });
  assert.deepEqual(s.callBarLayout(59, Number.NaN), { top: 0, contentTop: h });
});

test('ring timeout: «Нет ответа» online, «Нет соединения» with retry offline', () => {
  assert.deepEqual(s.ringExpiry('online'), { text: 'Нет ответа', retry: false });
  assert.deepEqual(s.ringExpiry('waiting'), { text: 'Нет соединения', retry: true });
  assert.deepEqual(s.ringExpiry('connecting'), { text: 'Нет соединения', retry: true });
  assert.ok(s.NETWORK_WAIT_MS > 0 && s.NETWORK_WAIT_MS < 60_000, 'an offline call does not hang for ever');
});

test('system call indicator text (Android notification)', () => {
  assert.equal(s.systemCallText('active', false, false, 'online'), 'Звонок');
  assert.equal(s.systemCallText('active', true, false, 'waiting'), 'Видеозвонок', 'a running call shows its kind; the chronometer runs');
  assert.equal(s.systemCallText('active', false, true, 'online'), 'Восстановление связи…');
  assert.equal(s.systemCallText('active', false, true, 'waiting'), 'Ожидание сети…');
  assert.equal(s.systemCallText('ringing', false, false, 'online'), 'Вызов…');
  assert.equal(s.systemCallText('requesting', false, false, 'waiting'), 'Ожидание сети…');
  assert.equal(s.systemCallText('connecting', false, false, 'online'), 'Соединение…');
});

test('every status text has an English entry', async () => {
  const { createRequire } = await import('node:module');
  const en = createRequire(import.meta.url)('../src/i18n/en.json');
  for (const text of ['Ожидание сети…', 'Соединение…', 'Вызов…', 'Запрос…', 'Восстановление связи…', 'Нет ответа', 'Нет соединения', 'Звонок', 'Видеозвонок', 'Входящий звонок', 'Входящий видеозвонок', 'Повторить', 'Закрыть', 'Завершить звонок', 'Текущий звонок', 'Собеседник', 'Вернуться к звонку'])
    assert.ok(en[text], `en.json: ${text}`);
});
