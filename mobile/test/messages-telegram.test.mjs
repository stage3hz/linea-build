import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { bigEmojiCount, foldChat, groupAlbums, pollFallback, validMeta } from '../src/messageMeta.ts';
import { sanitizeGif } from '../src/photo/gif.ts';

const msg = (id, senderId, extra = {}) => ({ id, chatId: 'c', senderId, clientId: randomUUID(), text: '', attachment: null, createdAt: new Date(1e12 + id).toISOString(), cryptoState: 'decrypted', ...extra });

test('poll and vote meta are validated strictly', () => {
  const poll = { question: 'Куда идём?', options: ['Кино', 'Парк'], multiple: false };
  assert.equal(validMeta({ poll }), true);
  assert.equal(validMeta({ poll: { ...poll, options: ['один'] } }), false, 'at least two options');
  assert.equal(validMeta({ poll: { ...poll, options: Array(11).fill('x') } }), false, 'at most ten options');
  assert.equal(validMeta({ poll: { ...poll, extra: 1 } }), false, 'no unknown keys');
  const target = randomUUID();
  assert.equal(validMeta({ action: { type: 'vote', target, options: [0] } }), true);
  assert.equal(validMeta({ action: { type: 'vote', target, options: [] } }), true, 'empty = retract');
  assert.equal(validMeta({ action: { type: 'vote', target, options: [1, 1] } }), false, 'duplicates rejected');
  assert.equal(validMeta({ action: { type: 'vote', target, options: [0] }, reply: { clientId: target, senderId: target, preview: '' } }), false, 'action is alone');
  assert.match(pollFallback(poll), /📊 Куда идём\?\n1\. Кино\n2\. Парк/);
});

test('votes fold into results; one live vote per person; invalid votes ignored', () => {
  const alice = randomUUID(), bob = randomUUID();
  const poll = msg(1, alice, { text: 'p', meta: { poll: { question: 'Q', options: ['A', 'B', 'C'], multiple: false } } });
  const vote = (id, who, options) => msg(id, who, { meta: { action: { type: 'vote', target: poll.clientId, options } } });
  const view = foldChat([poll, vote(2, alice, [0]), vote(3, bob, [2]), vote(4, bob, [1]), vote(5, bob, [0, 1]), vote(6, alice, [7])], alice);
  const result = view.byClientId.get(poll.clientId).poll;
  assert.deepEqual(result.counts, [1, 1, 0], 'bob changed his vote to B; multi-vote on single-choice and out-of-range are ignored');
  assert.deepEqual(result.mine, [0]);
  assert.equal(result.voters, 2);
  const retracted = foldChat([poll, vote(2, alice, [0]), vote(3, alice, [])], alice).byClientId.get(poll.clientId).poll;
  assert.deepEqual(retracted, { counts: [0, 0, 0], mine: [], voters: 0 });
  assert.equal(view.messages.length, 1, 'votes are not shown as bubbles');
});

test('album meta groups consecutive parts of one sender', () => {
  const id = randomUUID(), a = randomUUID(), b = randomUUID();
  assert.equal(validMeta({ album: { id, index: 0, count: 3 } }), true);
  assert.equal(validMeta({ album: { id, index: 3, count: 3 } }), false);
  assert.equal(validMeta({ album: { id, index: 0, count: 11 } }), false);
  const part = (i, sender = a) => ({ senderId: sender, meta: { album: { id, index: i, count: 3 } }, n: i });
  const groups = groupAlbums([{ senderId: a, n: 'x' }, part(0), part(1), part(2), { senderId: b, n: 'y' }]);
  assert.deepEqual(groups.map(g => g.map(item => item.n)), [['x'], [0, 1, 2], ['y']]);
  const foreign = groupAlbums([part(0), part(1, b)]);
  assert.equal(foreign.length, 2, 'another sender never joins someone else\'s album');
});

test('big emoji: only 1–3 emoji and nothing else', () => {
  assert.equal(bigEmojiCount('😀'), 1);
  assert.equal(bigEmojiCount('❤️ 🔥'), 2);
  assert.equal(bigEmojiCount('👍🏽'), 1, 'skin tone stays one emoji');
  assert.equal(bigEmojiCount('🇷🇺'), 1, 'flag is one emoji');
  assert.equal(bigEmojiCount('😀😀😀😀'), 0);
  assert.equal(bigEmojiCount('ok 😀'), 0);
  assert.equal(bigEmojiCount('1'), 0);
  assert.equal(bigEmojiCount(''), 0);
});

function gif({ comment = true, xmp = true } = {}) {
  const bytes = [...Buffer.from('GIF89a'), 2, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  bytes.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  if (comment) bytes.push(0x21, 0xfe, 6, ...Buffer.from('SECRET'), 0);
  if (xmp) bytes.push(0x21, 0xff, 11, ...Buffer.from('XMP DataXMP'), 4, ...Buffer.from('GPS!'), 0);
  for (let frame = 0; frame < 2; frame++) {
    bytes.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

test('GIF sanitizer keeps frames and loop, removes comments and XMP', () => {
  const clean = sanitizeGif(gif());
  const text = Buffer.from(clean.bytes).toString('latin1');
  assert.equal(clean.frames, 2);
  assert.equal(clean.width, 2); assert.equal(clean.height, 1);
  assert.ok(text.includes('NETSCAPE2.0'), 'loop count kept');
  assert.ok(!text.includes('SECRET'), 'comment removed');
  assert.ok(!text.includes('XMP') && !text.includes('GPS!'), 'XMP removed');
  assert.deepEqual(clean.bytes, sanitizeGif(gif({ comment: false, xmp: false })).bytes, 'same result as a GIF that never had metadata');
  assert.throws(() => sanitizeGif(Uint8Array.from([1, 2, 3])));
  assert.throws(() => sanitizeGif(gif().subarray(0, 40)), /повреждён/);
});

test('polls, votes and albums travel only inside the Signal ciphertext', async t => {
  const { harness } = await import('./support/crypto-harness.mjs');
  const { alice, bob, relay, chatId, approve } = await harness(t);
  await approve(alice, bob); await approve(bob, alice);
  const poll = { question: 'Секретный вопрос', options: ['Да', 'Нет'], multiple: false };
  const pollId = randomUUID();
  const sealed = await alice.service.encrypt(chatId, bob.userId, pollId, pollFallback(poll), null, { poll });
  assert.equal(JSON.stringify(sealed).includes('Секретный'), false);
  const voteId = randomUUID();
  const vote = await bob.service.encrypt(chatId, alice.userId, voteId, '🗳', null, { action: { type: 'vote', target: pollId, options: [1] } });
  const first = relay.deliver(alice.userId, chatId, pollId, sealed), second = relay.deliver(bob.userId, chatId, voteId, vote);
  await alice.service.syncChat(chatId);
  const opened = [await alice.service.preview(first), await alice.service.preview(second)];
  assert.ok(opened.every(m => m.cryptoState === 'decrypted'));
  const view = foldChat(opened, alice.userId);
  assert.deepEqual(view.byClientId.get(pollId).poll, { counts: [0, 1], mine: [], voters: 1 });
});
