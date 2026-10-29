import assert from 'node:assert/strict';
import test from 'node:test';
import { AIConversation, historyForQuestion, parseAIReply, parseAIStatus } from '../src/ai/conversation.ts';

const reply = text => ({ text, model: 'example/free-model:free', provider: 'openrouter', freeOnly: true });
const capabilities = Object.fromEntries(['text', 'code', 'image', 'video', 'threeD', 'social'].map(key => [key, { enabled: false, reason: 'Not configured' }]));
const complete = (id, question, answer) => ({ id, question, status: 'complete', answer: reply(answer) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('without an explicit AI consent no question leaves the conversation', async () => {
  const calls = [];
  const session = new AIConversation(async messages => { calls.push(messages); return reply('answer'); });
  await session.ask('hello');
  assert.deepEqual(calls, []); assert.equal(session.getSnapshot().turns.length, 0);
  assert.match(session.getSnapshot().error, /разреши/i);
});

test('wire history contains only successful AI turns and the explicit current question', () => {
  const turns = [complete(1, 'one', 'answer one'), { id: 2, question: 'failed', status: 'failed' }, complete(3, 'two', 'answer two')];
  assert.deepEqual(historyForQuestion(turns, '  next  '), [
    { role: 'user', content: 'one' }, { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'two' }, { role: 'assistant', content: 'answer two' },
    { role: 'user', content: 'next' },
  ]);
});

test('history refuses limits without silently dropping or truncating earlier text', () => {
  assert.throws(() => historyForQuestion([], 'x'.repeat(8001)), /8000/);
  assert.equal(historyForQuestion([], '🚀'.repeat(4000))[0].content.length, 8000);
  assert.throws(() => historyForQuestion(Array.from({ length: 10 }, (_, i) => complete(i, 'q', 'a')), 'next'), /новую беседу/i);
  assert.throws(() => historyForQuestion([complete(1, 'x'.repeat(8000), 'y'.repeat(8000)), complete(2, 'x'.repeat(8000), 'y'.repeat(8000))], 'next'), /новую беседу/i);
  assert.throws(() => historyForQuestion([complete(1, 'q', 'a'.repeat(8001))], 'next'), /новую беседу/i);
});

test('a successful answer records the actual model and sends no extra fields or system prompt', async () => {
  let request;
  const session = new AIConversation(async (messages, signal) => { request = { messages, signal }; return reply('done'); });
  session.setConsent(true); await session.ask('question');
  assert.deepEqual(request.messages, [{ role: 'user', content: 'question' }]);
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(session.getSnapshot().turns[0].answer.model, 'example/free-model:free');
  assert.equal(session.getSnapshot().pending, false);
});

test('retry reuses the failed question without duplicate user turns', async () => {
  const calls = []; let attempt = 0;
  const session = new AIConversation(async messages => { calls.push(messages); if (!attempt++) throw new Error('temporary'); return reply('done'); });
  session.setConsent(true); await session.ask('question');
  assert.equal(session.getSnapshot().turns[0].status, 'failed');
  await session.retry();
  assert.equal(session.getSnapshot().turns.length, 1); assert.equal(session.getSnapshot().turns[0].status, 'complete');
  assert.deepEqual(calls[0], calls[1]);
});

test('cancellation aborts the request and a late answer cannot change the cancelled turn', async () => {
  const output = deferred(); let signal;
  const session = new AIConversation(async (_messages, value) => { signal = value; return output.promise; });
  session.setConsent(true); const pending = session.ask('question');
  session.cancel(); assert.equal(signal.aborted, true);
  output.resolve(reply('late')); await pending;
  assert.equal(session.getSnapshot().turns[0].status, 'cancelled');
  assert.equal(session.getSnapshot().turns[0].answer, undefined);
});

test('revoking consent aborts the active question and prevents retry until allowed again', async () => {
  const output = deferred(); let calls = 0;
  const session = new AIConversation(async () => { calls += 1; return output.promise; });
  session.setConsent(true); const pending = session.ask('question');
  session.setConsent(false); await session.retry();
  output.resolve(reply('late')); await pending;
  assert.equal(calls, 1); assert.equal(session.getSnapshot().consent, false);
  assert.equal(session.getSnapshot().turns[0].answer, undefined);
});

test('new conversation removes its history and ignores the previous in-flight answer', async () => {
  const output = deferred();
  const session = new AIConversation(async () => output.promise);
  session.setConsent(true); const pending = session.ask('private question');
  session.clear(); output.resolve(reply('private answer')); await pending;
  assert.deepEqual(session.getSnapshot().turns, []); assert.equal(session.getSnapshot().pending, false);
});

test('unmount/logout closes the session, clears text and consent, and ignores late failures', async () => {
  const output = deferred();
  const session = new AIConversation(async () => output.promise);
  session.setConsent(true); const pending = session.ask('private question');
  session.close(); output.reject(new Error('late')); await pending;
  assert.deepEqual(session.getSnapshot().turns, []); assert.equal(session.getSnapshot().consent, false);
  assert.equal(session.getSnapshot().error, '');
});

test('double send during one in-flight request cannot create a second request', async () => {
  const output = deferred(); let calls = 0;
  const session = new AIConversation(async () => { calls += 1; return output.promise; });
  session.setConsent(true); const first = session.ask('one'); await session.ask('two');
  assert.equal(calls, 1); output.resolve(reply('done')); await first;
  assert.equal(session.getSnapshot().turns.length, 1);
});

test('unconfigured status is honest and a paid or malformed response is rejected', () => {
  assert.equal(parseAIStatus({ configured: false, provider: 'openrouter', model: 'openrouter/free', freeOnly: true, capabilities }).configured, false);
  assert.throws(() => parseAIStatus({ configured: true, provider: 'openrouter', model: 'paid/model', freeOnly: false }));
  assert.throws(() => parseAIReply({ ...reply('answer'), freeOnly: false }));
  assert.throws(() => parseAIReply({ ...reply('answer'), text: ' ' }));
  assert.throws(() => parseAIReply(reply('x'.repeat(16001))));
});

test('a self-hosted FreeLLMAPI provider is accepted with its own model id, unknown providers are not', () => {
  const capabilities = { text: { enabled: true }, code: { enabled: true }, image: { enabled: false, reason: 'нет' }, video: { enabled: false, reason: 'нет' }, threeD: { enabled: false, reason: 'нет' }, social: { enabled: false, reason: 'нет' } };
  const status = parseAIStatus({ configured: true, provider: 'freellmapi', model: 'auto', freeOnly: true, capabilities });
  assert.equal(status.provider, 'freellmapi');
  assert.equal(status.model, 'auto');
  assert.throws(() => parseAIStatus({ configured: true, provider: 'freellmapi', model: 'bad model', freeOnly: true, capabilities }));
  assert.throws(() => parseAIStatus({ configured: true, provider: 'openrouter', model: 'auto', freeOnly: true, capabilities }));
  assert.throws(() => parseAIStatus({ configured: true, provider: 'someone-else', model: 'auto', freeOnly: true, capabilities }));
  assert.equal(parseAIReply({ text: 'Ответ', model: 'groq/llama-3.3-70b', provider: 'freellmapi', freeOnly: true }).provider, 'freellmapi');
  assert.throws(() => parseAIReply({ text: 'Ответ', model: 'x', provider: 'paid', freeOnly: true }));
});
