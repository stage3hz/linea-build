import assert from 'node:assert/strict';
import test from 'node:test';
import { detectIntent, speechText } from '../src/ai/intent.ts';

test('one AI chat: the request itself decides between text, picture, video and speech', () => {
  for (const [text, photo, expected] of [
    ['Нарисуй кота-космонавта', false, 'image'], ['сгенерируй картинку заката', false, 'image'], ['Сделай мне аватарку в стиле аниме', false, 'image'],
    ['создай логотип для кафе', false, 'image'], ['draw a cat', false, 'image'], ['сделай видео с рассветом', false, 'video'], ['озвучь: привет мир', false, 'speech'],
    ['Ку че как?', false, 'text'], ['Как сделать фото лучше?', false, 'text'], ['Сделай план на неделю', false, 'text'], ['расскажи про картины Шишкина', false, 'text'],
    ['Что на этом фото?', true, 'text'], ['сделай из этого аниме', true, 'image'], ['в стиле Ван Гога', true, 'image'], ['убери фон', true, 'image'],
  ]) assert.equal(detectIntent(text, photo), expected, text);
  assert.equal(speechText('озвучь: привет мир'), 'привет мир');
});

test('a picture request is a task turn with its result in the same conversation', async () => {
  const ai = await import('../src/ai/conversation.ts');
  const owner = new ai.AIConversation(async () => ({ text: 'ok', model: 'm', provider: 'freellmapi', freeOnly: true }));
  owner.setConsent(true);
  const stages = [];
  await owner.askTask('Нарисуй кота', 'image', async (_signal, stage) => { stage('Рисую картинку'); stages.push(owner.getSnapshot().turns[0].stage); return { text: 'Готово', model: 'img', media: { uri: 'data:image/png;base64,AA==', mimeType: 'image/png' } }; });
  const turn = owner.getSnapshot().turns[0];
  assert.deepEqual(stages, ['Рисую картинку']);
  assert.equal(turn.status, 'complete'); assert.equal(turn.kind, 'image'); assert.equal(turn.media.mimeType, 'image/png'); assert.equal(turn.stage, undefined);
  const stored = ai.storedTurns(owner.getSnapshot().turns)[0];
  assert.equal(stored.kind, 'image'); assert.equal(stored.media, undefined);
});
