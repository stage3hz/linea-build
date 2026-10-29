import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const saved = loadTs(new URL('../src/saved/saved.ts', import.meta.url), {
  'react-native': { Platform: { OS: 'ios' } }, 'expo-crypto': {}, 'expo-file-system/legacy': {}, 'expo-sharing': {}, 'base64-js': {},
});
const now = '2026-10-29T17:00:00.000Z';
const note = (text, extra = {}) => ({ id: randomUUID(), savedAt: now, text, attachment: null, ...extra });
const attachment = { id: randomUUID(), name: 'voice-1.m4a', mimeType: 'audio/mp4', size: 1000, encryption: { scheme: 'aes-256-gcm-siv', key: 'A'.repeat(43) + '=', nonce: 'B'.repeat(16), fileKeyId: randomUUID() }, media: { durationMs: 3000 } };

test('notes and attachments are validated, kept in order and not duplicated', () => {
  const origin = { chatId: randomUUID(), clientId: randomUUID(), author: 'Маша', sentAt: now };
  let list = [];
  ({ list } = saved.addSaved(list, note('купить хлеб')));
  ({ list } = saved.addSaved(list, note('', { attachment })));
  const first = saved.addSaved(list, note('из чата', { origin }));
  assert.equal(first.added, true); list = first.list;
  const again = saved.addSaved(list, note('из чата', { origin }));
  assert.equal(again.added, false);
  assert.equal(list.length, 3);
  assert.throws(() => saved.addSaved(list, note('   ')), /пустое/);
  assert.throws(() => saved.addSaved(list, note('x'.repeat(8001))), /длинное/);
  assert.deepEqual(saved.searchSaved(list, 'маша').map(item => item.text), ['из чата']);
  assert.equal(saved.searchSaved(list, 'voice').length, 1);
});

test('edit, remove and parsing drop malformed entries', () => {
  const a = note('старый текст'), b = note('второй');
  let list = [a, b];
  list = saved.editSaved(list, a.id, '  новый текст ', now);
  assert.equal(list[0].text, 'новый текст'); assert.equal(list[0].editedAt, now);
  assert.throws(() => saved.editSaved(list, a.id, ' ', now));
  list = saved.removeSaved(list, b.id);
  assert.deepEqual(list.map(item => item.id), [a.id]);
  const raw = JSON.stringify([...list, { id: 'bad' }, note('', {}), 5]);
  assert.deepEqual(saved.parseSaved(raw).map(item => item.id), [a.id]);
  assert.deepEqual(saved.parseSaved('{oops'), []);
  assert.deepEqual(saved.parseSaved(null), []);
});
