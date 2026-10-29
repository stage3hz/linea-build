import assert from 'node:assert/strict';
import test from 'node:test';
import * as ai from '../src/ai/conversation.ts';

const capabilities = { text: { enabled: true }, code: { enabled: true, reason: 'Text only' }, image: { enabled: false, reason: 'No executor' }, video: { enabled: false, reason: 'No executor' }, threeD: { enabled: false, reason: 'No executor' }, social: { enabled: false, reason: 'No executor' } };
const status = { configured: true, provider: 'openrouter', model: 'openrouter/free', freeOnly: true, capabilities };
const prior = [{ id: 1, question: 'before', status: 'complete', answer: { text: 'answer', model: 'free-model', provider: 'openrouter', freeOnly: true } }];

test('tool availability comes from validated capability flags and missing or malformed flags are rejected', () => {
  const parsed = ai.parseAIStatus(status);
  assert.equal(parsed.capabilities.image.enabled, false);
  assert.equal(parsed.capabilities.code.enabled, true);
  assert.throws(() => ai.parseAIStatus({ ...status, capabilities: { ...capabilities, image: { enabled: 'true' } } }));
  assert.throws(() => ai.parseAIStatus({ ...status, capabilities: undefined }));
});

test('a code task preview contains the exact outgoing request and explicitly limits the task to a text answer', () => {
  const preview = ai.createCodeTaskPreview(prior, '  Напиши функцию сортировки  ');
  assert.ok(preview.prompt.endsWith('Напиши функцию сортировки'));
  assert.match(preview.prompt, /запуск кода и изменение файлов не запрашиваются/);
  assert.deepEqual(preview.messages, [
    { role: 'user', content: 'before' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: preview.prompt },
  ]);
  assert.equal(ai.codePreviewCurrent(prior, preview), true);
  assert.equal(ai.codePreviewCurrent([], preview), false);
});

test('the code-task instruction counts toward the message limit and cannot silently truncate the task', () => {
  const description = 'x'.repeat(ai.AI_MESSAGE_LIMIT - ai.CODE_TASK_PREFIX.length);
  assert.equal(ai.createCodeTaskPreview([], description).prompt.length, 8000);
  assert.throws(() => ai.createCodeTaskPreview([], `${description}x`), /8000/);
});
