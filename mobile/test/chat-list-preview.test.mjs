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
  // The target is the clientId, as on the wire; the author is the action's sender.
  const list = [msg(1, 'первое'), msg(2, 'второе'), msg(3, '🗑', { type: 'delete', target: 'k2' }), msg(4, '✏️', { type: 'edit', target: 'k1', text: 'первое (изм.)' })];
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

test('a message deleted «у меня» is not the chat list line: the list looks past it', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/useMessenger.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("listPreviewMessage([...loaded,last].filter(message=>!hidden.has(messageKey(message))))"), 'hidden messages are not candidates in an opened chat');
  assert.ok(source.includes("skippedInList(last)||hidden.has(messageKey(last))"), 'a hidden last message makes the list read the recent page');
  assert.ok(source.includes("if(!shown&&lastHidden)return {...chat,lastMessage:{...last,text:'',attachment:null}};"), 'never the hidden text while nothing else is known');
  // The rule itself: with the hidden message left out, the previous real message is the line.
  const list = [msg(1, 'Да'), msg(2, 'Привет, дорогой')];
  assert.equal(listPreviewMessage(list.filter(m => m.id !== 2)).text, 'Да');
});
