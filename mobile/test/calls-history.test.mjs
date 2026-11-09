// F9 — История звонков: classification, Telegram duration formatting, grouping by day, the service row and the chat-list line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const model = loadTs(new URL('../src/calls/callModel.ts', import.meta.url), {});
const history = loadTs(new URL('../src/calls/callLog.ts', import.meta.url), {});
const meta = loadTs(new URL('../src/messageMeta.ts', import.meta.url), {});

const me = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222';
const callA = '0b6f1b9a-1f0e-4c43-9a35-0e6f0c1d2e3f', callB = '1c7f2caa-2f1f-4d54-8b46-1f7f1d2e3f4a', callC = '2d8f3dbb-3f2f-4e65-9c57-2f8f2e3f4a5b';
const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';
let seq = 0;
const msg = (id, senderId, action, extra = {}) => ({ id, chatId: 'c1', senderId, clientId: `k${id}-${seq++}`, text: action ? meta.actionFallback(action) : 'hi', attachment: null, createdAt: new Date(Date.UTC(2026, 10, 7, 10, 0, id)).toISOString(), cryptoState: 'decrypted', meta: action ? { action } : undefined, ...extra });
const end = (call, fields) => ({ type: 'call', call, step: 'end', ...fields });
const user = (id, name) => ({ id, username: name.toLowerCase(), displayName: name, bio: '', avatarColor: '#000', avatarId: null, createdAt: '' });
const chatOf = (id, who, lastMessage = null, lastReadMessageId = 0) => ({ id, peer: who, lastMessage, unreadCount: 0, lastReadMessageId, peerLastReadMessageId: 0, createdAt: '', updatedAt: '' });

test('Telegram duration: 0:42, 3:12, 1:02:05', () => {
  assert.equal(model.formatCallDuration(42), '0:42');
  assert.equal(model.formatCallDuration(192), '3:12');
  assert.equal(model.formatCallDuration(3725), '1:02:05');
  assert.equal(model.formatCallDuration(3600), '1:00:00');
  assert.equal(model.formatCallDuration(0), '0:00');
  assert.equal(model.formatCallDuration(125.9), '2:05', 'whole seconds');
  assert.equal(model.formatCallDuration(-5), '0:00');
  assert.equal(model.formatCallDuration(NaN), '0:00');
});

test('the outcome fields travel only inside the encrypted `end` and are validated strictly', () => {
  assert.equal(meta.validMeta({ action: end(callA, { reason: 'hangup', duration: 192, caller: true, video: true }) }), true);
  assert.equal(meta.validMeta({ action: end(callA, { reason: 'missed', caller: true }) }), true);
  assert.equal(meta.validMeta({ action: { type: 'call', call: callA, step: 'offer', sdp, duration: 5 } }), false, 'an offer has no duration');
  assert.equal(meta.validMeta({ action: { type: 'call', call: callA, step: 'answer', sdp, caller: false } }), false, 'an answer has no caller flag');
  assert.equal(meta.validMeta({ action: end(callA, { duration: -1 }) }), false);
  assert.equal(meta.validMeta({ action: end(callA, { duration: 1.5 }) }), false);
  assert.equal(meta.validMeta({ action: end(callA, { duration: 8 * 86400 }) }), false, 'longer than a week is not a call');
  assert.equal(meta.validMeta({ action: end(callA, { caller: 'yes' }) }), false);
});

test('classification from this account\'s point of view (who called, how it ended)', () => {
  const c = (fields, senderId) => history.classifyCall(fields, senderId, me);
  assert.equal(c({ reason: 'hangup', duration: 192, caller: true }, me), 'outgoing', 'I called and hung up');
  assert.equal(c({ reason: 'hangup', duration: 192, caller: false }, peer), 'outgoing', 'I called, the peer hung up');
  assert.equal(c({ reason: 'hangup', duration: 42, caller: true }, peer), 'incoming', 'the peer called and hung up');
  assert.equal(c({ reason: 'hangup', duration: 42, caller: false }, me), 'incoming', 'the peer called, I hung up');
  assert.equal(c({ reason: 'missed', caller: true }, peer), 'missed', 'the peer gave up ringing me');
  assert.equal(c({ reason: 'missed', caller: true }, me), 'cancelled', 'nobody answered my call (or I cancelled it)');
  assert.equal(c({ reason: 'declined', caller: false }, peer), 'declined');
  assert.equal(c({ reason: 'declined', caller: false }, me), 'declined');
  assert.equal(c({ reason: 'busy', caller: false }, peer), 'busy', 'the peer was in another call');
  assert.equal(c({ reason: 'busy', caller: false }, me), 'missed', 'my phone was busy: I never saw their call');
  assert.equal(c({ reason: 'failed', caller: true }, me), 'failed');
  // Older clients send no `caller`: the reason tells who sent the `end`.
  assert.equal(c({ reason: 'missed' }, peer), 'missed');
  assert.equal(c({ reason: 'declined' }, me), 'declined');
  assert.equal(c({ reason: 'busy' }, peer), 'busy');
  assert.equal(c({ reason: 'hangup' }, me), 'outgoing');
  assert.equal(c({ reason: 'hangup' }, peer), 'incoming');
});

test('the service row reads like Telegram, with the duration only for answered calls', () => {
  const t = (fields, senderId) => history.callServiceText(fields, senderId, me);
  assert.equal(t({ reason: 'hangup', duration: 192, caller: true }, me), 'Исходящий звонок · 3:12');
  assert.equal(t({ reason: 'hangup', duration: 42, caller: true, video: true }, peer), 'Входящий видеозвонок · 0:42');
  assert.equal(t({ reason: 'hangup', duration: 3725, caller: false }, peer), 'Исходящий звонок · 1:02:05');
  assert.equal(t({ reason: 'hangup', caller: true }, me), 'Исходящий звонок', 'an old client sends no duration');
  assert.equal(t({ reason: 'missed', caller: true }, peer), 'Пропущенный звонок');
  assert.equal(t({ reason: 'missed', caller: true, video: true }, me), 'Отменённый видеозвонок');
  assert.equal(t({ reason: 'declined', caller: false, duration: 0 }, peer), 'Отклонённый звонок', 'no duration on a declined call');
  assert.equal(t({ reason: 'busy', caller: false }, peer), 'Собеседник занят');
  assert.equal(t({ reason: 'failed', caller: true }, me), 'Звонок не удался');
});

test('chat-list line: the stored fallback names no direction, a missed call reads «Пропущенный звонок»', () => {
  assert.equal(meta.actionFallback(end(callA, { reason: 'missed', caller: true })), '📞 Пропущенный звонок');
  assert.equal(meta.actionFallback(end(callA, { reason: 'hangup', duration: 192, caller: true })), '📞 Звонок · 3:12');
  assert.equal(meta.actionFallback(end(callA, { reason: 'hangup', duration: 42, video: true })), '📹 Видеозвонок · 0:42');
  assert.equal(meta.actionFallback(end(callA, { reason: 'declined' })), '📞 Отклонённый звонок');
  assert.equal(meta.actionFallback(end(callA, { reason: 'busy' })), '📞 Отклонённый звонок');
  assert.equal(meta.actionFallback(end(callA, { reason: 'failed', video: true })), '📹 Видеозвонок не удался');
  assert.equal(meta.actionFallback({ type: 'call', call: callA, step: 'offer', sdp }), '📞 Звонок', 'offers are unchanged');
  // The list renders from the meta, so an older client's text («📞 Звонок завершён») is shown the new way.
  assert.equal(meta.chatListText({ text: '📞 Звонок завершён', meta: { action: end(callA, { reason: 'hangup', duration: 7 }) } }), '📞 Звонок · 0:07');
  assert.equal(meta.chatListText({ text: 'обычный текст' }), 'обычный текст');
  assert.equal(meta.isQuietAction({ meta: { action: end(callA, { reason: 'missed' }) } }), false, 'a finished call replaces the list preview');
});

test('foldChat: one service row per call; offers and answers stay invisible; the `end` with a duration wins', () => {
  const list = [
    msg(1, me, { type: 'call', call: callA, step: 'offer', sdp }),
    msg(2, peer, { type: 'call', call: callA, step: 'answer', sdp }),
    msg(3, peer, end(callA, { reason: 'failed', caller: false })),
    msg(4, me, end(callA, { reason: 'hangup', duration: 15, caller: true })),
    msg(5, peer, end(callB, { reason: 'missed', caller: true })),
    msg(6, me, 'text-less'),
  ];
  list[5] = { ...list[5], meta: undefined, text: 'после звонка' };
  const view = meta.foldChat(list, me);
  assert.deepEqual(view.messages.map(m => m.id), [4, 5, 6]);
  assert.equal(view.messages[0].meta.action.duration, 15);
  const hidden = meta.foldChat(list, me, new Set([meta.messageKey(list[4])]));
  assert.deepEqual(hidden.messages.map(m => m.id), [4, 6], '«удалить у меня» works on a call row too');
  const undecrypted = meta.foldChat([{ ...list[4], cryptoState: 'no-key' }], me);
  assert.equal(undecrypted.messages.length, 0, 'an `end` this device cannot read is not a row');
});

test('history is built from the loaded pages and each chat\'s last message, newest first, with the missed badge', () => {
  const ira = user(peer, 'Ира'), oleg = user('33333333-3333-4333-8333-333333333333', 'Олег');
  const loaded = {
    c1: [msg(1, me, { type: 'call', call: callA, step: 'offer', sdp }), msg(2, me, end(callA, { reason: 'hangup', duration: 192, caller: true })), msg(3, peer, end(callB, { reason: 'missed', caller: true }))],
  };
  const lastOleg = { ...msg(9, oleg.id, end(callC, { reason: 'missed', caller: true })), chatId: 'c2' };
  const chats = [chatOf('c1', ira, loaded.c1[2], 2), chatOf('c2', oleg, lastOleg, 0)];
  const records = history.buildCallHistory(chats, loaded, me);
  assert.deepEqual(records.map(r => [r.chat.peer.displayName, r.kind, r.duration, r.unseen]), [
    ['Олег', 'missed', undefined, true],
    ['Ира', 'missed', undefined, true],
    ['Ира', 'outgoing', 192, false],
  ]);
  const read = history.buildCallHistory([chatOf('c1', ira, loaded.c1[2], 3)], loaded, me);
  assert.equal(read[0].unseen, false, 'read past the missed call: no badge');
  assert.equal(history.unseenMissedCount(records), 2);
  const twice = history.buildCallHistory([chatOf('c1', ira, loaded.c1[2], 2)], { c1: [...loaded.c1, msg(4, me, end(callA, { reason: 'failed', caller: true }))] }, me);
  assert.equal(twice.filter(r => r.callId === callA).length, 1, 'both phones sent an `end`: one entry');
  assert.equal(twice.find(r => r.callId === callA).duration, 192, 'the `end` with the duration is kept');
  assert.equal(history.buildCallHistory([chatOf('c1', ira, { ...loaded.c1[1], cryptoState: 'no-key', meta: undefined })], {}, me).length, 0, 'a last message with no decrypted meta is skipped');
});

test('grouping by day: Сегодня / Вчера, newest first, neighbours of one kind fold into «(n)»', () => {
  // Local components: the grouping is by local day, so the test must not depend on the machine's time zone.
  const now = new Date(2026, 10, 7, 12, 0, 0).getTime();
  const ira = user(peer, 'Ира'), oleg = user('33333333-3333-4333-8333-333333333333', 'Олег');
  const at = (daysAgo, hour) => new Date(now - daysAgo * 86400_000 - (12 - hour) * 3600_000).toISOString();
  const rec = (messageId, chat, kind, time, extra = {}) => ({ key: `${chat.id}:${messageId}`, callId: `${messageId}`, messageId, clientId: `${messageId}`, chat, at: time, kind, video: false, unseen: false, ...extra });
  const c1 = chatOf('c1', ira), c2 = chatOf('c2', oleg);
  const groups = history.groupCallsByDay([
    rec(1, c1, 'outgoing', at(1, 9), { duration: 10 }),
    rec(2, c1, 'missed', at(0, 9), { unseen: true }),
    rec(3, c1, 'missed', at(0, 10)),
    rec(4, c2, 'incoming', at(0, 11), { duration: 42 }),
    rec(5, c1, 'missed', at(0, 11.5)),
    rec(6, c1, 'outgoing', at(3, 8), { video: true }),
  ], now);
  assert.deepEqual(groups.map(g => g.label), ['Сегодня', 'Вчера', groups[2].label]);
  assert.notEqual(groups[2].label, 'Вчера');
  assert.deepEqual(groups[0].calls.map(c => [c.chat.peer.displayName, c.kind, c.count, c.unseen]), [
    ['Ира', 'missed', 1, false],
    ['Олег', 'incoming', 1, false],
    ['Ира', 'missed', 2, true],
  ], 'a call of someone else in between keeps the rows apart; the folded row carries the badge');
  assert.deepEqual(groups[1].calls.map(c => [c.kind, c.duration]), [['outgoing', 10]]);
  assert.equal(history.groupCallsByDay([], now).length, 0);
  assert.equal(history.callDayLabel(at(0, 1), now), 'Сегодня');
  assert.equal(history.callDayLabel(at(1, 23), now), 'Вчера');
});

test('chat list: the line for a finished call carries the direction, unlike the stored fallback', () => {
  const line = (fields, senderId, extra = {}) => history.callListText({ senderId, cryptoState: 'decrypted', meta: { action: end(callA, fields) }, ...extra }, me);
  assert.equal(line({ reason: 'missed', caller: true }, peer), 'Пропущенный звонок');
  assert.equal(line({ reason: 'missed', caller: true }, me), 'Отменённый звонок');
  assert.equal(line({ reason: 'hangup', duration: 192, caller: true }, me), 'Исходящий звонок · 3:12');
  assert.equal(line({ reason: 'hangup', duration: 42, caller: true, video: true }, peer), 'Входящий видеозвонок · 0:42');
  assert.equal(line({ reason: 'missed', caller: true }, peer, { cryptoState: undefined }), 'Пропущенный звонок', 'a server lastMessage with its meta but no crypto state');
  assert.equal(line({ reason: 'missed', caller: true }, peer, { cryptoState: 'no-key' }), null, 'an unreadable `end` falls back to the stored text');
  assert.equal(history.callListText({ senderId: peer, cryptoState: 'decrypted', meta: { action: { type: 'call', call: callA, step: 'offer', sdp } } }, me), null, 'an offer is not a row');
  assert.equal(history.callListText({ senderId: peer, cryptoState: 'decrypted', text: 'привет' }, me), null);
});

test('one dedupe for the chat and the history: isCallEnd / dedupeCallEnds live in messageMeta', () => {
  const both = [msg(3, peer, end(callA, { reason: 'failed', caller: false })), msg(4, me, end(callA, { reason: 'hangup', duration: 15, caller: true })), msg(5, peer, end(callB, { reason: 'missed', caller: true })), msg(6, me, end(callB, { reason: 'missed', caller: true }))];
  assert.deepEqual(meta.dedupeCallEnds(both).map(m => m.id), [4, 5], 'the duration wins; otherwise the earliest');
  assert.deepEqual(meta.dedupeCallEnds([...both].reverse()).map(m => m.id).sort(), [4, 5], 'the same `end`s are chosen whatever the input order (callers sort the result)');
  // callHistory re-exports the same helpers (loadTs builds a module cache per load, so compare behaviour, not identity).
  assert.deepEqual(history.dedupeCallEnds(both).map(m => m.id), meta.dedupeCallEnds(both).map(m => m.id));
  assert.equal(history.isCallEnd(both[0]), true);
  assert.equal(meta.isCallEnd({ meta: { action: end(callA, { reason: 'missed' }) }, cryptoState: 'no-key' }), false);
  assert.equal(meta.isCallEnd({ meta: { action: end(callA, { reason: 'missed' }) } }), true);
});
