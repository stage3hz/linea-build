import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

/** A fresh module instance over an in-memory AsyncStorage (optionally pre-filled, as after a restart). */
function outbox(stored = {}) {
  const values = new Map(Object.entries(stored));
  const o = loadTs(new URL('../src/communities/channelOutbox.ts', import.meta.url), {
    '@react-native-async-storage/async-storage': {
      getItem: async key => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      multiRemove: async keys => { for (const key of keys) values.delete(key); },
    },
    react: { useSyncExternalStore: () => [] },
  });
  return { o, values };
}
const KEY = 'linea.channel-outbox.v1:u1';
const fields = (text, extra = {}) => ({ communityId: 'c1', channelId: 'g', text, ...extra });
const ok = item => ({ id: 1, channelId: item.channelId, text: item.text });

test('parseOutbox keeps only well-formed items and drops duplicates / garbage', () => {
  const { o } = outbox();
  assert.deepEqual(o.parseOutbox(null), []);
  assert.deepEqual(o.parseOutbox('not json'), []);
  assert.deepEqual(o.parseOutbox('{"a":1}'), []);
  const list = o.parseOutbox(JSON.stringify([
    { key: 'a', communityId: 'c', channelId: 'g', text: 'hi', replyTo: 3, createdAt: '2026-01-01T00:00:00.000Z' },
    { key: 'a', communityId: 'c', channelId: 'g', text: 'dup' },
    { key: 'b', communityId: 'c', channelId: 'g', text: '   ' },
    { key: 'c', communityId: 'c', channelId: 'g', text: 'bad reply', replyTo: 'x' },
    { key: 'x'.repeat(65), communityId: 'c', channelId: 'g', text: 'key too long for the server' },
    { key: 'd', communityId: 'c', channelId: 'g', text: 'ok' },
    null, 7,
  ]));
  assert.deepEqual(list.map(item => item.key), ['a', 'd']);
  assert.equal(list[0].replyTo, 3); assert.equal(list[1].replyTo, undefined);
  assert.equal(typeof list[1].createdAt, 'string');
});

test('the storage key is bound to the account; enqueue persists and the queue is read back after a restart', async () => {
  const first = outbox();
  assert.equal(o_key(first.o), 'linea.channel-outbox.v1:u1');
  first.o.attachChannelOutbox({ userId: 'u1', send: async () => { throw new Error('offline'); } });
  first.o.enqueueChannelMessage(fields('one'));
  first.o.enqueueChannelMessage(fields('two', { replyTo: 5 }));
  first.o.enqueueChannelMessage({ communityId: 'c2', channelId: 'other', text: 'elsewhere' });
  await settle();
  const raw = first.values.get(KEY);
  assert.ok(raw, 'queue written to storage under the account key');
  assert.deepEqual(JSON.parse(raw).map(item => item.text), ['one', 'two', 'elsewhere']);
  assert.deepEqual(first.o.channelOutbox('g').map(item => item.text), ['one', 'two']);
  assert.ok(JSON.parse(raw).every(item => item.key.length <= 64));

  // Restart: a new module instance over the same storage, no channel screen involved.
  const second = outbox({ [KEY]: raw });
  const sent = [];
  second.o.attachChannelOutbox({ userId: 'u1', send: async item => { sent.push(item); return ok(item); } });
  await settle();
  assert.deepEqual(sent.map(item => item.text), ['one', 'two', 'elsewhere']);
  assert.equal(sent[1].replyTo, 5);
  assert.equal(second.o.channelOutboxSize(), 0);
  assert.deepEqual(JSON.parse(second.values.get(KEY)), []);

  // Another account over the same storage never sees (or sends) that queue.
  const third = outbox({ [KEY]: raw });
  const leaked = [];
  third.o.attachChannelOutbox({ userId: 'u2', send: async item => { leaked.push(item); return ok(item); } });
  await settle();
  assert.deepEqual(leaked, []);
  assert.equal(third.values.get(KEY), raw, 'the other account\'s queue stays untouched on disk');
});
const o_key = o => o.storageKeyFor('u1');

test('a message queued before the disk read finished does not clobber what was stored', async () => {
  let release; const stored = JSON.stringify([{ key: 'old', communityId: 'c1', channelId: 'g', text: 'from before the restart', createdAt: '2026-01-01T00:00:00.000Z' }]);
  const values = new Map([[KEY, stored]]);
  const o = loadTs(new URL('../src/communities/channelOutbox.ts', import.meta.url), {
    '@react-native-async-storage/async-storage': {
      getItem: key => key === KEY ? new Promise(resolve => { release = () => resolve(stored); }) : Promise.resolve(null),
      setItem: async (key, value) => { values.set(key, value); }, multiRemove: async () => {},
    },
    react: { useSyncExternalStore: () => [] },
  });
  o.attachChannelOutbox({ userId: 'u1', send: async () => { throw new Error('offline'); } });
  o.enqueueChannelMessage(fields('typed right after login'));
  await settle();
  assert.equal(values.get(KEY), stored, 'nothing written while the read is pending');
  release(); await settle();
  assert.deepEqual(JSON.parse(values.get(KEY)).map(item => item.text), ['from before the restart', 'typed right after login']);
  assert.deepEqual(o.channelOutbox('g').map(item => item.text), ['from before the restart', 'typed right after login']);
});

test('flush stops at a network failure and resumes on the next «ready», keeping order', async () => {
  const { o } = outbox();
  let online = false; const sent = []; const events = [];
  const listeners = new Set();
  const onSocket = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  o.onChannelOutbox(event => events.push(event.type));
  o.attachChannelOutbox({ userId: 'u1', send: async item => { if (!online) throw new Error('Нет соединения.'); sent.push(item.text); return ok(item); }, onSocket });
  o.enqueueChannelMessage(fields('a')); o.enqueueChannelMessage(fields('b'));
  await o.flushChannelOutbox();
  assert.deepEqual(sent, []); assert.equal(o.channelOutboxSize(), 2);
  // Unrelated socket events do not flush; «ready» does.
  listeners.forEach(l => l({ type: 'community.message' }));
  await settle(); assert.deepEqual(sent, []);
  online = true;
  listeners.forEach(l => l({ type: 'ready' }));
  await settle();
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(events, ['sent', 'sent']);
  assert.equal(o.channelOutboxSize(), 0);
});

test('a timeout (no status) is retried, not dropped; a 4xx drops the message into «не отправлено» and the rest still goes out', async () => {
  const { o, values } = outbox();
  const sent = []; const failed = []; let timedOut = false;
  o.onChannelOutbox(event => { if (event.type === 'failed') failed.push([event.item.text, event.error]); });
  o.enqueueChannelMessage(fields('slow')); o.enqueueChannelMessage(fields('forbidden')); o.enqueueChannelMessage(fields('fine'));
  o.attachChannelOutbox({ userId: 'u1', send: async item => {
    if (item.text === 'slow' && !timedOut) { timedOut = true; throw Object.assign(new Error('Сервер не ответил вовремя.'), { name: 'TimeoutError' }); }
    if (item.text === 'forbidden') throw Object.assign(new Error('Нет прав писать в канал.'), { status: 403 });
    sent.push(item.text); return ok(item);
  } });
  await settle();
  assert.deepEqual(sent, [], 'the timeout stops the flush, the message stays queued');
  assert.equal(o.channelOutboxSize(), 3);
  await o.flushChannelOutbox();
  assert.deepEqual(sent, ['slow', 'fine']);
  assert.deepEqual(failed, [['forbidden', 'Нет прав писать в канал.']]);
  assert.equal(o.channelOutboxSize(), 0);
  assert.deepEqual(o.channelOutboxFailures('g').map(f => [f.item.text, f.error]), [['forbidden', 'Нет прав писать в канал.']]);
  await settle();
  assert.equal(JSON.parse(values.get(`${KEY}:failed`)).length, 1, 'the failure list survives a restart');
  // Shown when the channel is opened next, until dismissed.
  const later = outbox({ [`${KEY}:failed`]: values.get(`${KEY}:failed`) });
  later.o.attachChannelOutbox({ userId: 'u1', send: async item => ok(item) });
  await settle();
  assert.deepEqual(later.o.channelOutboxFailures('g').map(f => f.item.text), ['forbidden']);
  assert.deepEqual(later.o.channelOutboxFailures('other'), []);
  later.o.dismissChannelFailure(later.o.channelOutboxFailures()[0].item.key);
  assert.deepEqual(later.o.channelOutboxFailures(), []);
});

test('the queue is capped at 200 with a clear error; a reused key is the same item (no duplicate)', () => {
  const { o } = outbox();
  o.attachChannelOutbox({ userId: 'u1', send: async () => { throw new Error('offline'); } });
  for (let i = 0; i < o.OUTBOX_LIMIT; i++) o.enqueueChannelMessage(fields(`m${i}`));
  assert.throws(() => o.enqueueChannelMessage(fields('one too many')), { message: o.OUTBOX_FULL });
  assert.match(o.OUTBOX_FULL, /200/);
  assert.equal(o.channelOutboxSize(), 200);
  o.removeChannelMessage(o.channelOutbox()[0].key);
  const item = o.enqueueChannelMessage(fields('retry', { key: 'fixed-key' }));
  assert.equal(item.key, 'fixed-key');
  assert.equal(o.enqueueChannelMessage(fields('retry', { key: 'fixed-key' })), item);
  assert.equal(o.channelOutboxSize(), 200);
});

test('a waiting message can be cancelled; concurrent flush calls do not double-send', async () => {
  const { o } = outbox();
  const item = o.enqueueChannelMessage(fields('cancel me')); o.enqueueChannelMessage(fields('keep'));
  o.removeChannelMessage(item.key); o.removeChannelMessage('missing');
  assert.deepEqual(o.channelOutbox().map(i => i.text), ['keep']);
  const sent = []; let release;
  o.attachChannelOutbox({ userId: 'u1', send: item => new Promise(resolve => { release = () => { sent.push(item.text); resolve(ok(item)); }; }) });
  await settle();
  void o.flushChannelOutbox(); void o.flushChannelOutbox();
  release(); await settle();
  assert.deepEqual(sent, ['keep']);
});

test('attach with the same socket re-uses the subscription; reset forgets the transport and the queue, purge wipes the disk', async () => {
  const { o, values } = outbox();
  let subscriptions = 0;
  const onSocket = () => { subscriptions++; return () => {}; };
  const transport = { userId: 'u1', send: async () => { throw new Error('offline'); }, onSocket };
  o.attachChannelOutbox(transport); o.attachChannelOutbox({ ...transport }); o.attachChannelOutbox(transport);
  assert.equal(subscriptions, 1);
  o.enqueueChannelMessage(fields('x'));
  await settle();
  assert.equal(JSON.parse(values.get(KEY)).length, 1);
  // Messenger teardown without a logout: memory is dropped, the disk copy stays for the next attach.
  o.resetChannelOutbox();
  assert.equal(o.channelOutboxSize(), 0); assert.equal(o.channelOutboxOwner(), null);
  await settle();
  assert.equal(JSON.parse(values.get(KEY)).length, 1);
  o.enqueueChannelMessage(fields('nobody signed in'));
  await settle();
  assert.equal(JSON.parse(values.get(KEY)).length, 1, 'nothing is written without an account');
  o.attachChannelOutbox(transport);
  await settle();
  assert.deepEqual(o.channelOutbox().map(i => i.text), ['x', 'nobody signed in']);
  // Logout: the account's queue is wiped from the disk too.
  o.resetChannelOutbox({ purge: true });
  await settle();
  assert.equal(values.has(KEY), false);
  assert.equal(o.channelOutboxSize(), 0);
});

test('a send in flight when the account signs out never touches the next account\'s queue', async () => {
  const { o } = outbox();
  let release; const events = [];
  o.onChannelOutbox(event => events.push(event.type));
  o.attachChannelOutbox({ userId: 'u1', send: item => new Promise(resolve => { release = () => resolve(ok(item)); }) });
  o.enqueueChannelMessage(fields('from u1'));
  await settle();
  o.resetChannelOutbox({ purge: true });
  o.attachChannelOutbox({ userId: 'u2', send: async () => { throw new Error('offline'); } });
  o.enqueueChannelMessage(fields('from u2'));
  release(); await settle();
  assert.deepEqual(events, []);
  assert.deepEqual(o.channelOutbox().map(i => i.text), ['from u2']);
});
