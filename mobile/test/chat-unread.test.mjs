import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitingDecryption, countUnread, coversUnread, readUpTo, readWatermark, reconcileUnread } from '../src/chatUnread.ts';
import { CHATS, countChats, plural } from '../src/plural.ts';

const me = 'me', peer = 'peer', device = 'dev-1';
const msg = (id, senderId = peer, extra = {}) => ({ id, chatId: 'c', senderId, clientId: `k${id}`, text: 't', createdAt: '', cryptoState: 'decrypted', ...extra });
const react = (id, senderId = peer) => msg(id, senderId, { meta: { action: { type: 'react', target: 'me:k1', emoji: '❤️' } } });
const chat = (unreadCount, lastReadMessageId, lastMessage) => ({ id: 'c', peer: { id: peer }, unreadCount, lastReadMessageId, peerLastReadMessageId: 0, createdAt: '', updatedAt: '', lastMessage });

test('B43: the client count skips actions, my own messages and Mesh copies', () => {
  const list = [msg(1, me), msg(2), react(3), msg(4, me), msg(5), msg(9e15 + 1, peer, { mesh: true })];
  assert.equal(countUnread(list, 0, me), 2);
  assert.equal(countUnread(list, 2, me), 1);
});

test('a missed call of the peer counts as unread (Telegram); other call rows do not', () => {
  const call = (id, senderId, step, reason) => msg(id, senderId, { meta: { action: { type: 'call', call: '0f1e2d3c-0000-4000-8000-000000000001', step, reason } } });
  assert.equal(countUnread([call(1, peer, 'offer'), call(2, peer, 'end', 'missed')], 0, me), 1, 'the peer called and gave up');
  assert.equal(countUnread([call(1, peer, 'offer'), call(2, me, 'answer'), call(3, peer, 'end', 'hangup')], 0, me), 0, 'an answered call');
  assert.equal(countUnread([call(1, peer, 'offer'), call(2, me, 'end', 'declined')], 0, me), 0, 'declined by me');
  assert.equal(countUnread([call(1, me, 'offer'), call(2, me, 'end', 'missed')], 0, me), 0, 'my own call nobody answered');
  assert.equal(countUnread([call(1, me, 'offer'), call(2, peer, 'end', 'busy')], 0, me), 0, 'the peer was busy with another call');
});

test('B43: coversUnread — the loaded set must reach both the watermark and the newest server message', () => {
  const c = chat(1, 5, react(20));
  assert.equal(coversUnread(c, [react(20)]), false, 'a reaction that just arrived over the socket for a chat never opened');
  assert.equal(coversUnread(c, [react(20)], false), true, 'unless the server says there is nothing above it');
  assert.equal(coversUnread(c, [msg(5), react(20)]), true);
  assert.equal(coversUnread(c, [msg(5), msg(19)]), false);
  assert.equal(coversUnread(c, undefined), false);
  assert.equal(coversUnread(c, [msg(9e15 + 1, peer, { mesh: true })]), false);
});

test('B43: a reaction of the peer after my last read does not light the chat up when its messages are loaded', () => {
  const loaded = [msg(1, me), react(2)];
  const fixed = reconcileUnread(chat(1, 1, react(2)), loaded, me);
  assert.equal(fixed.unreadCount, 0);
  // Real unread messages keep the server's count.
  const same = chat(1, 1, msg(2));
  assert.equal(reconcileUnread(same, [msg(1, me), msg(2)], me), same);
});

test('B43: the server count stays when the loaded page does not reach the watermark or the newest message', () => {
  const c = chat(3, 5, msg(20));
  assert.equal(reconcileUnread(c, [msg(10), react(20)], me), c, 'older unread rows are not loaded');
  assert.equal(reconcileUnread(c, [msg(4), msg(10)], me), c, 'the newest message is not loaded yet');
  assert.equal(reconcileUnread(c, [msg(10), react(20)], me, false).unreadCount, 1, 'no more above: the page is the whole chat');
  assert.equal(reconcileUnread(chat(0, 5, msg(20)), [msg(20)], me).unreadCount, 0);
  assert.equal(reconcileUnread(c, [], me), c);
});

test('B13: «Прочитать» from the list reaches the newest server message, not the shown one', () => {
  assert.equal(readUpTo({ lastMessage: react(7) }, 5), 7, 'the list shows message 5 while the last row is a reaction');
  assert.equal(readUpTo({ lastMessage: msg(5) }, 5), 5);
  assert.equal(readUpTo(undefined, 5), 5);
  assert.equal(readUpTo({ lastMessage: null }, 0), 0);
});

test('B17: permanent states do not keep the chat unread; pending ones do', () => {
  const envFor = (userId, deviceId) => ({ scheme: 'signal-v1', senderDeviceId: 'x', envelopes: [{ userId, deviceId, type: 3, body: '' }], attachmentIds: [] });
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'decrypted' }), me, device), false);
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'legacy' }), me, device), false);
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'failed' }), me, device), false);
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'invalid' }), me, device), false);
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'no-key', encrypted: envFor(me, 'other-device') }), me, device), false, 'sent before this device signed in');
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'no-key', encrypted: envFor(me, device) }), me, device), true, 'inbox sync has not opened it yet');
  // The real pages and the socket are lean: no envelopes. Before the inbox sync of the chat went through the key may still come; after it, it never will.
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'no-key' }), me, device), true, 'lean copy, inbox not synced yet');
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'no-key' }), me, device, false), true);
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'no-key' }), me, device, true), false, 'lean copy after a successful inbox sync: no key is coming');
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'unverified' }), me, device, true), true, 'an unconfirmed sender device waits whatever the sync says');
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'no-key', encrypted: envFor(me, device) }), me, device, true), true, 'with envelopes the envelope speaks, not the sync flag');
  assert.equal(awaitingDecryption(msg(1, peer, { cryptoState: 'unverified', encrypted: envFor(me, device) }), me, device), true);
});

test('B17: the read watermark stops before the first message still waiting for keys', () => {
  const envFor = (deviceId) => ({ scheme: 'signal-v1', senderDeviceId: 'x', envelopes: [{ userId: me, deviceId, type: 3, body: '' }], attachmentIds: [] });
  const old = msg(1, peer, { cryptoState: 'no-key', encrypted: envFor('other-device') });
  assert.equal(readWatermark([old, msg(2, peer, { cryptoState: 'failed' }), msg(3)], me, device), 3);
  assert.equal(readWatermark([old], me, device), 1, 'a chat of pre-login messages only is read once opened');
  assert.equal(readWatermark([msg(1), msg(2, peer, { cryptoState: 'no-key', encrypted: envFor(device) }), msg(3)], me, device), 1);
  const lean = id => msg(id, peer, { cryptoState: 'no-key' });
  assert.equal(readWatermark([lean(1)], me, device), 0, 'lean page before the inbox sync: the key may still come');
  assert.equal(readWatermark([lean(1)], me, device, false), 0);
  assert.equal(readWatermark([lean(1), msg(2), lean(3)], me, device, true), 3, 'lean page after the inbox sync: permanent no-key rows are read, the chat does not stay unread forever');
  assert.equal(readWatermark([msg(1), msg(2, peer, { cryptoState: 'unverified' }), msg(3)], me, device, true), 1);
  assert.equal(readWatermark([], me, device), 0);
});

test('B44: plural forms for чат', () => {
  const expected = { 1: 'чат', 2: 'чата', 4: 'чата', 5: 'чатов', 11: 'чатов', 12: 'чатов', 14: 'чатов', 15: 'чатов', 20: 'чатов', 21: 'чат', 22: 'чата', 24: 'чата', 25: 'чатов', 100: 'чатов', 101: 'чат', 111: 'чатов', 112: 'чатов', 121: 'чат', 122: 'чата' };
  for (const [n, form] of Object.entries(expected)) assert.equal(plural(Number(n), CHATS), form, `n=${n}`);
  assert.equal(countChats(21), '21 чат');
  assert.equal(countChats(0), '0 чатов');
  assert.equal(plural(3, ['голос', 'голоса', 'голосов']), 'голоса');
});
