import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const history = loadTs(new URL('../src/ai/history.ts', import.meta.url), { react: { useCallback: f => f, useEffect: () => {}, useRef: v => ({ current: v }), useState: v => [v, () => {}] } });
const answer = { text: 'Ответ', model: 'auto', provider: 'freellmapi', freeOnly: true };
const turn = (id, question, extra = {}) => ({ id, question, status: 'complete', answer, ...extra });

test('conversations are stored newest first without photos and with pending turns cancelled', () => {
  let list = history.upsertConversation([], 'conv-0001', [turn(1, 'Как дела?', { options: { model: 'auto:fast', image: 'data:image/jpeg;base64,AAAA' } })], true, '2026-10-29T10:00:00.000Z');
  list = history.upsertConversation(list, 'conv-0002', [turn(1, 'Второй вопрос'), { id: 2, question: 'ждём', status: 'pending' }], false, '2026-10-29T11:00:00.000Z');
  assert.deepEqual(list.map(c => c.id), ['conv-0002', 'conv-0001']);
  assert.equal(list[1].turns[0].options.image, undefined);
  assert.equal(list[1].turns[0].options.model, 'auto:fast');
  assert.equal(list[0].turns[1].status, 'cancelled');
  assert.equal(list[1].title, 'Как дела?');
  const parsed = history.parseAIHistory(JSON.stringify([...list, { id: 'x' }, 7]));
  assert.deepEqual(parsed.map(c => c.id), ['conv-0002', 'conv-0001']);
  assert.deepEqual(history.parseAIHistory('nope'), []);
  assert.deepEqual(history.upsertConversation(list, 'conv-0002', [], false, '2026-10-29T12:00:00.000Z').map(c => c.id), ['conv-0001']);
});

test('private turns never reach the stored history, even when private mode is switched off later', () => {
  const turns = [turn(1, 'Обычный вопрос'), turn(2, 'Приватный вопрос', { private: true })];
  const list = history.upsertConversation([], 'conv-0003', turns, true, '2026-10-29T13:00:00.000Z');
  assert.deepEqual(list[0].turns.map(t => t.id), [1]);
  assert.equal(list[0].title, 'Обычный вопрос');
  // A conversation made only of private turns is not stored at all (and an earlier copy is dropped).
  const onlyPrivate = history.upsertConversation(list, 'conv-0003', [turn(3, 'Секрет', { private: true })], true, '2026-10-29T14:00:00.000Z');
  assert.deepEqual(onlyPrivate, []);
});

test('generated media are stored by cache file name (the folder moves between app updates) and foreign or data URIs are not stored', () => {
  const file = 'file:///cache/linea-ai-conv-0004-abc.png';
  const turns = [turn(1, 'нарисуй кота', { kind: 'image', media: { uri: file, mimeType: 'image/png' } }), turn(2, 'озвучь', { kind: 'speech', media: { uri: 'data:audio/mpeg;base64,AAAA', mimeType: 'audio/mpeg' } })];
  const list = history.upsertConversation([], 'conv-0004', turns, true, '2026-10-29T15:00:00.000Z');
  assert.deepEqual(list[0].turns[0].media, { uri: 'linea-ai-conv-0004-abc.png', mimeType: 'image/png' });
  assert.equal(list[0].turns[1].media, undefined);
  assert.deepEqual(history.parseAIHistory(JSON.stringify(list))[0].turns[0].media, { uri: 'linea-ai-conv-0004-abc.png', mimeType: 'image/png' });
  // An older history still holds absolute URIs: accepted, and normalised to the name on the next save.
  const legacy = JSON.parse(JSON.stringify(list)); legacy[0].turns[0].media.uri = file;
  assert.deepEqual(history.parseAIHistory(JSON.stringify(legacy))[0].turns[0].media, { uri: file, mimeType: 'image/png' });
  assert.deepEqual(history.upsertConversation([], 'conv-0004', history.parseAIHistory(JSON.stringify(legacy))[0].turns, true, '2026-10-29T16:00:00.000Z')[0].turns[0].media.uri, 'linea-ai-conv-0004-abc.png');
  for (const bad of ['file:///etc/passwd', 'file:///cache/../linea-ai-conv-0004-abc.png', 'linea-ai-conv-0004-abc.png?x=1', 'linea-ai-conv-0004-abc.png#frag', '../linea-ai-conv-0004-abc.png', 'file:///cache/linea-ai-conv-0004-abc.png/../../x.png', 'linea-ai-conv 0004.png', 'linea-ai-.png']) {
    const tampered = JSON.parse(JSON.stringify(list)); tampered[0].turns[0].media.uri = bad;
    assert.deepEqual(history.parseAIHistory(JSON.stringify(tampered)), [], bad);
  }
});

test('the media of a private turn never reaches the stored turns, whatever the other turns', () => {
  const secret = { uri: 'file:///cache/linea-ai-conv-0005-secret.png', mimeType: 'image/png' };
  const turns = [turn(1, 'Обычный вопрос'), turn(2, 'нарисуй тайну', { kind: 'image', private: true, media: secret }), turn(3, 'нарисуй кота', { kind: 'image', media: { uri: 'file:///cache/linea-ai-conv-0005-cat.png', mimeType: 'image/png' } })];
  const stored = history.upsertConversation([], 'conv-0005', turns, true, '2026-10-29T17:00:00.000Z')[0];
  assert.deepEqual(stored.turns.map(t => t.id), [1, 3]);
  assert.ok(!JSON.stringify(stored).includes('secret'));
  assert.ok(!JSON.stringify(stored).includes('тайну'));
  assert.deepEqual(stored.turns[1].media, { uri: 'linea-ai-conv-0005-cat.png', mimeType: 'image/png' });
});
