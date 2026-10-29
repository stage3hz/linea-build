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
