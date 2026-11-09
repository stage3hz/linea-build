import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { harness } from './support/crypto-harness.mjs';
import { nodeSignalBridge } from './support/signal-node.mjs';
import { actionFallback, editWindowOpen, EDIT_WINDOW_MS, foldChat, listPreviewMessage, skippedInList } from '../src/messageMeta.ts';
import { awaitsInbox, catchUpTargets, keepOpened, NOT_FOR_DEVICE, settled } from '../src/listCatchUp.ts';

const lean = message => ({ ...message, encrypted: undefined, lean: true });
const chat = (id, last, extra = {}) => ({ id, peer: { id: 'p' }, lastMessage: last, unreadCount: 0, lastReadMessageId: 0, peerLastReadMessageId: 0, createdAt: '', updatedAt: '2026-11-09T10:00:00.000Z', ...extra });
const closed = id => ({ id, chatId: 'c', senderId: 'p', clientId: randomUUID(), text: 'Зашифрованное сообщение. Открой чат для расшифровки.', attachment: null, createdAt: '', cryptoState: 'no-key', lean: true });

/** Counts what goes to Signal: a ratchet key is single-use, so one message must be opened once. */
function countDecrypts(t) {
  const original = nodeSignalBridge.decrypt; const counter = { calls: 0 };
  nodeSignalBridge.decrypt = async (...args) => { counter.calls++; return original.apply(nodeSignalBridge, args); };
  t.after(() => { nodeSignalBridge.decrypt = original; });
  return counter;
}

test('list catch-up: messages that came while the app was closed read as text before the chat is opened, each decrypted once', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const decrypts = countDecrypts(t);
  const sent = [];
  for (const text of ['Привет', 'Ты где?', 'Позвони, как сможешь']) {
    const id = randomUUID();
    sent.push(relay.deliver(alice.userId, chatId, id, await alice.service.encrypt(chatId, bob.userId, id, text, null)));
  }
  // The chat list (lean): nothing opened yet on Bob's phone — the closed line the owner saw.
  const last = lean(sent.at(-1));
  const before = await bob.service.preview(last);
  assert.equal(before.cryptoState, 'no-key');
  assert.ok(awaitsInbox(before));
  assert.deepEqual(catchUpTargets([chat(chatId, before)], () => false), [chatId]);
  // Catch-up, a socket message and the chat being opened at the same time share one sync.
  await Promise.all([bob.service.syncChat(chatId, 5), bob.service.syncChat(chatId), bob.service.syncChat(chatId, 5)]);
  assert.equal(decrypts.calls, 3, 'each message went to Signal exactly once');
  const after = await bob.service.preview(last);
  assert.equal(after.cryptoState, 'decrypted');
  assert.equal(after.text, 'Позвони, как сможешь');
  // Again (resume, the chat opened): nothing is decrypted a second time.
  await bob.service.syncChat(chatId); await bob.service.syncChat(chatId, 5);
  assert.equal(decrypts.calls, 3);
});

test('list catch-up is bounded: a short pass stops after its pages and the next sync goes on from the cursor', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  relay.pageSize = 1;
  const sent = [];
  for (let i = 0; i < 4; i++) { const id = randomUUID(); sent.push(relay.deliver(alice.userId, chatId, id, await alice.service.encrypt(chatId, bob.userId, id, `сообщение ${i}`, null))); }
  const decrypts = countDecrypts(t);
  await assert.rejects(bob.service.syncChat(chatId, 2), { name: 'PartialSync' });
  assert.equal(decrypts.calls, 2);
  assert.equal((await bob.service.preview(lean(sent[1]))).cryptoState, 'decrypted');
  assert.equal((await bob.service.preview(lean(sent[3]))).cryptoState, 'no-key');
  await bob.service.syncChat(chatId);
  assert.equal(decrypts.calls, 4, 'the rest, not the first two again');
  assert.equal((await bob.service.preview(lean(sent[3]))).text, 'сообщение 3');
});

test('list catch-up: own messages from another device, media, calls and edits read like Telegram', async t => {
  const { alice, bob, relay, chatId, approve, make } = await harness(t);
  const laptop = await make(bob.userId); // Bob's second device
  for (const [a, b] of [[alice, bob], [bob, alice], [laptop, alice]]) await approve(a, b); // each snapshot covers own other devices too
  const send = async (from, to, text, attachment = null, meta) => { const id = randomUUID(); return relay.deliver(from.userId, chatId, id, await from.service.encrypt(chatId, to.userId, id, text, attachment, meta)); };
  const photo = { id: randomUUID(), name: 'IMG_0001.jpg', mimeType: 'image/jpeg', size: 300, encryption: { scheme: 'aes-256-gcm-siv', key: Buffer.alloc(32, 1).toString('base64'), nonce: Buffer.alloc(12, 2).toString('base64'), fileKeyId: randomUUID() } };
  const original = await send(alice, bob, 'Встречаемся в 7?');
  const fromLaptop = await send(laptop, alice, 'Да, с ноутбука');
  const picture = await send(alice, bob, '', photo);
  const edit = { type: 'edit', target: original.clientId, text: 'Встречаемся в 8?' };
  const edited = await send(alice, bob, actionFallback(edit), null, { action: edit });
  const call = randomUUID();
  const offer = await send(alice, bob, '📞 Звонок', null, { action: { type: 'call', call, step: 'offer', sdp: 'v=0\r\n' } });
  await bob.service.syncChat(chatId, 5);
  const page = await Promise.all([original, fromLaptop, picture, edited, offer].map(m => bob.service.preview(lean(m))));
  assert.ok(page.every(m => m.cryptoState === 'decrypted'), 'the phone opens what its laptop sent too');
  assert.equal(page[1].text, 'Да, с ноутбука');
  assert.equal(page[2].attachment.name, 'IMG_0001.jpg', 'a photo keeps its attachment for «🖼 Фотография»');
  // The call offer and the edit are not the list line; the photo is.
  assert.equal(skippedInList(page[4]), true);
  assert.equal(listPreviewMessage(page).clientId, picture.clientId);
  // Without the photo: the edited text of the original, not «✏️ Изменено: …» and not the old text.
  assert.equal(listPreviewMessage([page[0], page[3], page[4]]).text, 'Встречаемся в 8?');
  const view = foldChat(page, bob.userId);
  assert.equal(view.byClientId.get(original.clientId).text, 'Встречаемся в 8?');
  assert.equal(view.byClientId.get(original.clientId).edited, true);
});

test('list preview applies edits and deletions by their real target (clientId of the author), not of someone else', () => {
  const me = 'me', peer = 'peer', k1 = randomUUID(), k2 = randomUUID();
  const m = (id, senderId, clientId, text, action) => ({ id, chatId: 'c', senderId, clientId: clientId ?? randomUUID(), text, attachment: null, createdAt: '', cryptoState: 'decrypted', ...(action ? { meta: { action } } : {}) });
  const list = [m(1, peer, k1, 'первое'), m(2, peer, k2, 'второе'), m(3, peer, null, '🗑', { type: 'delete', target: k2 }), m(4, peer, null, '✏️', { type: 'edit', target: k1, text: 'первое (изм.)' })];
  assert.equal(listPreviewMessage(list).text, 'первое (изм.)');
  // Only the author edits: an «edit» from the other side does not change the line.
  assert.equal(listPreviewMessage([m(1, peer, k1, 'текст'), m(2, me, null, '✏️', { type: 'edit', target: k1, text: 'подделка' })]).text, 'текст');
  // The latest edit wins.
  assert.equal(listPreviewMessage([m(1, me, k1, 'a'), m(2, me, null, '', { type: 'edit', target: k1, text: 'b' }), m(3, me, null, '', { type: 'edit', target: k1, text: 'c' })]).text, 'c');
  // A finished call is the line; its signalling is not.
  assert.equal(listPreviewMessage([m(1, peer, k1, 'привет'), m(2, peer, null, '📞', { type: 'call', call: k2, step: 'offer', sdp: 'v=0' })]).text, 'привет');
});

test('catch-up selection: closed lines only, unread first, bounded, never the same message twice', () => {
  const list = [
    chat('a', closed(5), { updatedAt: '2026-11-09T09:00:00.000Z' }),
    chat('b', closed(7), { unreadCount: 2, updatedAt: '2026-11-08T09:00:00.000Z' }),
    chat('c', { ...closed(9), cryptoState: 'decrypted', text: 'Привет' }),
    chat('d', closed(3), { updatedAt: '2026-11-09T11:00:00.000Z' }),
    chat('e', null),
  ];
  assert.deepEqual(catchUpTargets(list, () => false), ['b', 'd', 'a']);
  assert.deepEqual(catchUpTargets(list, (id, messageId) => id === 'b' && messageId === 7), ['d', 'a']);
  assert.deepEqual(catchUpTargets(list, () => false, 1), ['b']);
  // A new message in a tried chat is tried again.
  assert.deepEqual(catchUpTargets([chat('b', closed(8))], (id, messageId) => id === 'b' && messageId === 7), ['b']);
});

test('an inbox read through without a key says so honestly; an opened line is never closed again by a list refresh', () => {
  const line = closed(4);
  assert.equal(settled(line).text, NOT_FOR_DEVICE);
  assert.equal(settled(line).cryptoState, 'no-key');
  const failed = { ...line, cryptoState: 'failed', text: 'Не удалось расшифровать…' };
  assert.equal(settled(failed), failed, '«Не удалось расшифровать…» stays as it is');
  const opened = { ...line, cryptoState: 'decrypted', text: 'Привет' };
  assert.equal(keepOpened([chat('x', line)], [chat('x', opened)])[0].lastMessage.text, 'Привет');
  // A newer server message is taken as it is.
  assert.equal(keepOpened([chat('x', closed(5))], [chat('x', opened)])[0].lastMessage.id, 5);
});

test('editing: 48 hours like Telegram', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  assert.equal(editWindowOpen(new Date(now - 3600_000).toISOString(), now), true);
  assert.equal(editWindowOpen(new Date(now - EDIT_WINDOW_MS + 1000).toISOString(), now), true);
  assert.equal(editWindowOpen(new Date(now - EDIT_WINDOW_MS - 1).toISOString(), now), false);
  assert.equal(editWindowOpen('not a date', now), false);
});

// ---- review follow-ups ----
import { recentlyTried, RETRY_AFTER_MS, syncForList, CATCH_UP_EXTRA_PASSES } from '../src/listCatchUp.ts';
import { EDIT_CLOCK_SKEW_MS, editInTime } from '../src/messageMeta.ts';
import { retryFocus } from '../src/focusRetry.ts';
import { composerValue, typedInto } from '../src/editDraft.ts';

const at = ms => new Date(Date.parse('2026-11-01T00:00:00.000Z') + ms).toISOString();
const own = (id, clientId, text, createdAt, action) => ({ id, chatId: 'c', senderId: 'me', clientId: clientId ?? randomUUID(), text, attachment: null, createdAt, cryptoState: 'decrypted', ...(action ? { meta: { action } } : {}) });

test('an edit sent past 48 h (+10 min for clocks) is ignored in the chat and in the list; an earlier one in time still counts', () => {
  const k = randomUUID(), hour = 3600_000;
  const original = own(1, k, 'было', at(0));
  const inTime = own(2, null, '', at(47 * hour), { type: 'edit', target: k, text: 'в срок' });
  const skewed = own(3, null, '', at(EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS - 1000), { type: 'edit', target: k, text: 'часы спешат' });
  const late = own(4, null, '', at(EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS + 1000), { type: 'edit', target: k, text: 'поздно' });
  assert.equal(editInTime(at(0), at(EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS + 1)), false);
  assert.equal(foldChat([original, inTime, late], 'me').byClientId.get(k).text, 'в срок');
  assert.equal(listPreviewMessage([original, inTime, late]).text, 'в срок');
  assert.equal(foldChat([original, inTime, skewed], 'me').byClientId.get(k).text, 'часы спешат');
  assert.equal(listPreviewMessage([original, inTime, skewed]).text, 'часы спешат');
  const onlyLate = foldChat([original, late], 'me').byClientId.get(k);
  assert.equal(onlyLate.text, 'было'); assert.equal(onlyLate.edited, false);
  assert.equal(listPreviewMessage([original, late]).text, 'было');
});

test('a chat whose last message did not open is tried again for it at most once a minute (no retry storm on ready/resume)', () => {
  const now = 1_000_000;
  assert.equal(recentlyTried(undefined, 5, now), false);
  assert.equal(recentlyTried({ id: 5, at: now - 1000 }, 5, now), true);
  assert.equal(recentlyTried({ id: 5, at: now - RETRY_AFTER_MS }, 5, now), false);
  assert.equal(recentlyTried({ id: 5, at: now - 1000 }, 6, now), false, 'a new message is tried at once');
  const list = [chat('a', closed(5)), chat('b', closed(7))];
  const tried = new Map([['a', { id: 5, at: now - 1000 }]]);
  assert.deepEqual(catchUpTargets(list, (id, messageId) => recentlyTried(tried.get(id), messageId, now)), ['b']);
});

test('a long inbox queue goes on from the cursor for a few more passes (deep chats only); errors are told apart', async () => {
  const partial = () => Object.assign(new Error('часть'), { name: 'PartialSync' });
  let calls = 0;
  assert.equal(await syncForList(async () => { if (++calls < 3) throw partial(); }, true), 'synced');
  assert.equal(calls, 3);
  calls = 0;
  assert.equal(await syncForList(async () => { calls++; throw partial(); }, true), 'partial');
  assert.equal(calls, 1 + CATCH_UP_EXTRA_PASSES, 'bounded');
  calls = 0;
  assert.equal(await syncForList(async () => { calls++; throw partial(); }, false), 'partial');
  assert.equal(calls, 1, 'not a deep chat this round: one pass');
  assert.equal(await syncForList(async () => { throw Object.assign(new Error('сеть'), { name: 'NetworkError' }); }, true), 'network');
  assert.equal(await syncForList(async () => { throw new Error('CRYPTO_FAILED'); }, true), 'failed');
});

test('a long queue really continues from the cursor and each message is decrypted once', async t => {
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  relay.pageSize = 1;
  const sent = [];
  for (let i = 0; i < 6; i++) { const id = randomUUID(); sent.push(relay.deliver(alice.userId, chatId, id, await alice.service.encrypt(chatId, bob.userId, id, `№${i}`, null))); }
  const decrypts = countDecrypts(t);
  assert.equal(await syncForList(() => bob.service.syncChat(chatId, 2), true, 4), 'synced');
  assert.equal(decrypts.calls, 6);
  assert.equal((await bob.service.preview(lean(sent[5]))).text, '№5');
});

test('focus retries stop at the first confirmed focus and after the keyboard is put away', () => {
  const queue = [];
  const timers = { set: (fn, ms) => { queue.push({ fn, ms, live: true }); return queue.length - 1; }, clear: id => { queue[id].live = false; } };
  const run = () => { for (const item of queue) if (item.live) { item.live = false; item.fn(); } };
  // Behind a closing Modal: the first focus is lost, the second gets through, the third is not needed.
  let focused = false, asks = 0;
  const field = { isFocused: () => focused, focus: () => { asks++; if (asks === 2) focused = true; } };
  retryFocus(field, [60, 320, 650], timers);
  run();
  assert.equal(asks, 2);
  // The field got focus, the person put the keyboard away: the next retries do not take it back.
  queue.length = 0; focused = false; asks = 0;
  const retry = retryFocus({ isFocused: () => false, focus: () => { asks++; } }, [60, 320, 650], timers);
  queue[0].fn(); queue[0].live = false; // first ask
  retry.focused(); retry.keyboardHidden();
  run();
  assert.equal(asks, 1);
  // A keyboard-down before the field ever had focus (the menu closing) does not stop them.
  queue.length = 0; asks = 0;
  const early = retryFocus({ isFocused: () => false, focus: () => { asks++; } }, [60, 320], timers);
  early.keyboardHidden(); run();
  assert.equal(asks, 2);
});

test('editing never writes the chat draft: leaving or cancelling mid-edit keeps what was typed before', () => {
  let draft = 'черновик до правки', edit = 'Встречаемся в 7?';
  const into = { edit: v => { edit = v; }, draft: v => { draft = v; } };
  assert.equal(composerValue(true, edit, draft), 'Встречаемся в 7?');
  typedInto(true, 'Встречаемся в 8?', into);
  assert.equal(draft, 'черновик до правки');
  assert.equal(composerValue(true, edit, draft), 'Встречаемся в 8?');
  // The chat changed / the edit was cancelled: the field shows the draft again, nothing of the edit is in it.
  assert.equal(composerValue(false, '', draft), 'черновик до правки');
  typedInto(false, 'черновик до правки!', into);
  assert.equal(draft, 'черновик до правки!');
  assert.equal(composerValue(false, '', undefined), '');
});

test('a placeholder from a vault/Signal exception is never turned into «недоступно на данном устройстве»', async () => {
  const { afterSync } = await import('../src/listCatchUp.ts');
  const broken = { ...closed(3), text: 'Зашифрованное сообщение недоступно на этом устройстве.' };
  assert.deepEqual(afterSync(broken, 'synced', false), { line: broken, caughtUp: false });
  assert.equal(afterSync(closed(3), 'partial', true).caughtUp, false);
  assert.equal(afterSync(closed(3), 'failed', true).line.text, closed(3).text);
  const verdict = afterSync(closed(3), 'synced', true);
  assert.equal(verdict.caughtUp, true); assert.equal(verdict.line.text, NOT_FOR_DEVICE);
});
