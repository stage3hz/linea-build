import assert from 'node:assert/strict';
import test from 'node:test';
import { listPreviewMessage } from '../src/messageMeta.ts';

const msg = (id, text, action) => ({ id, chatId: 'c', senderId: 'u', clientId: `k${id}`, text, createdAt: '', ...(action ? { meta: { action } } : {}) });

test('chat list: reactions, unpins and votes do not replace the last real message', () => {
  const list = [msg(1, 'Выдал'), msg(2, '❤️', { type: 'react', target: 'u:k1', emoji: '❤️' }), msg(3, '📌', { type: 'pin', target: null })];
  assert.equal(listPreviewMessage(list).text, 'Выдал');
});

test('chat list: a pin with a target is shown (Telegram shows «pinned …»)', () => {
  const list = [msg(1, 'Выдал'), msg(2, '📌 Закреплено', { type: 'pin', target: 'u:k1' })];
  assert.equal(listPreviewMessage(list).id, 2);
});

test('chat list: a deleted last message falls back to the one before, an edit shows the new text', () => {
  const list = [msg(1, 'первое'), msg(2, 'второе'), msg(3, '🗑', { type: 'delete', target: 'u:k2' }), msg(4, '✏️', { type: 'edit', target: 'u:k1', text: 'первое (изм.)' })];
  assert.equal(listPreviewMessage(list).text, 'первое (изм.)');
  assert.equal(listPreviewMessage([msg(5, '❤️', { type: 'react', target: 'u:k9', emoji: '❤️' })]), null);
});

test('a pin reads like Telegram in the chat list: «Вы закрепили «…»» / «Имя закрепил(а) «…»», no emoji', async () => {
  const { loadTs } = await import('./support/load-ts.mjs');
  const meta = loadTs(new URL('../src/messageMeta.ts', import.meta.url), {});
  assert.equal(meta.pinPreview('📌 Закреплено сообщение «Слышь»', true, 'Ира'), 'Вы закрепили «Слышь»');
  assert.equal(meta.pinPreview('Закреплено сообщение «Чеза ник у тебя»', false, 'Ира'), 'Ира закрепил(а) «Чеза ник у тебя»');
  assert.equal(meta.pinPreview('Закреплено сообщение', false, 'Ира'), 'Ира закрепил(а) сообщение');
});
