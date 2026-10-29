import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAiRoutes } from '../src/ai.js';

const KEY = 'test-server-key-not-a-real-secret';
const body = (content = 'Объясни этот пример.') => ({ messages: [{ role: 'user', content }], consent: true });
const good = (content = 'Ответ', model = 'example/model:free') => new Response(JSON.stringify({
  model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { cost: 0 },
}), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, options = {}) {
  const calls = [];
  const app = Fastify({ logger: false });
  app.decorateRequest('auth', null);
  if (options.onRequest) app.addHook('onRequest', options.onRequest);
  registerAiRoutes(app, {
    apiKey: KEY,
    authenticate: async request => {
      if (request.headers.authorization !== 'Bearer test-session') {
        throw Object.assign(new Error('Войдите в аккаунт.'), { statusCode: 401 });
      }
      request.auth = { user_id: 42 };
    },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return good(); },
    ...options,
  });
  await app.ready();
  t.after(() => app.close());
  const post = (payload = body(), extra = {}) => app.inject({
    method: 'POST', url: '/ai/chat', payload,
    headers: { authorization: 'Bearer test-session', ...extra },
  });
  const status = () => app.inject({ method: 'GET', url: '/ai/status', headers: { authorization: 'Bearer test-session' } });
  return { app, calls, post, status };
}

test('AI status is authenticated, reflects configuration, and never claims media executors', async t => {
  const f = await fixture(t);
  assert.equal((await f.app.inject('/ai/status')).statusCode, 401);
  const response = await f.status();
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.configured, true);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'openrouter/free');
  assert.equal(result.freeOnly, true);
  assert.equal(result.capabilities.text.enabled, true);
  assert.equal(result.capabilities.code.enabled, true);
  for (const name of ['image', 'video', 'threeD', 'social']) {
    assert.equal(result.capabilities[name].enabled, false);
    assert.ok(result.capabilities[name].reason.length > 5);
  }
  assert.equal(f.calls.length, 0);
  assert.ok(!response.body.includes(KEY));
});

test('missing key disables status and chat without any upstream request', async t => {
  const f = await fixture(t, { apiKey: '' });
  const status = (await f.status()).json();
  assert.equal(status.configured, false);
  assert.equal(status.capabilities.text.enabled, false);
  assert.equal(status.capabilities.code.enabled, false);
  const response = await f.post();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'AI_NOT_CONFIGURED');
  assert.equal(f.calls.length, 0);
});

test('chat only forwards the approved text to the fixed free route with zero price and privacy constraints', async t => {
  const f = await fixture(t);
  const payload = { messages: [{ role: 'user', content: '  function x() {\n return 1;\n}' }, { role: 'assistant', content: 'Пример.' }, { role: 'user', content: 'Объясни.' }], consent: true };
  const response = await f.post(payload);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { text: 'Ответ', model: 'example/model:free', provider: 'openrouter', freeOnly: true });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers.Cookie, undefined);
  const sent = JSON.parse(init.body);
  assert.equal(sent.model, 'openrouter/free');
  assert.deepEqual(sent.messages, payload.messages);
  assert.deepEqual(sent.provider.max_price, { prompt: 0, completion: 0, request: 0 });
  assert.equal(sent.provider.data_collection, 'deny');
  assert.equal(sent.provider.zdr, true);
  assert.equal(sent.provider.require_parameters, true);
  assert.equal(sent.provider.allow_fallbacks, true);
  assert.equal(sent.stream, false);
  assert.equal(sent.max_tokens, 2048);
  assert.equal(sent.models, undefined);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.plugins, undefined);
  assert.equal(sent.user, undefined);
  assert.ok(!response.body.includes(KEY));
});

test('unauthenticated, foreign-origin and unapproved calls never reach a provider', async t => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ method: 'POST', url: '/ai/chat', payload: body() })).statusCode, 401);
  assert.equal((await f.post(body(), { origin: 'https://untrusted.example' })).statusCode, 403);
  for (const consent of [false, undefined, 'true', 1]) {
    const response = await f.post({ ...body(), consent });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('clients cannot force paid models, arbitrary origins, system roles, tools or hidden attachments', async t => {
  const f = await fixture(t);
  for (const extra of [{ model: 'paid/model' }, { models: ['paid/model'] }, { baseUrl: 'http://127.0.0.1/' }, { url: 'https://attacker.example' }, { provider: {} }, { tools: [] }, { taskType: 'video' }]) {
    assert.equal((await f.post({ ...body(), ...extra })).statusCode, 400);
  }
  for (const message of [{ role: 'system', content: 'secret' }, { role: 'tool', content: 'secret' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private' } }] }, { role: 'user', content: 'x', file: '/private' }, { role: 'assistant', content: 'Only assistant' }]) {
    assert.equal((await f.post({ messages: [message], consent: true })).statusCode, 400);
  }
  for (const roles of [['assistant', 'user'], ['user', 'assistant']]) {
    assert.equal((await f.post({ messages: roles.map(role => ({ role, content: 'x' })), consent: true })).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('message count, individual text, total text, malformed Unicode and HTTP body are bounded without truncation', async t => {
  const f = await fixture(t);
  const invalid = [
    body('x'.repeat(8001)), body('  '), body('\ud800'), body('x\0y'),
    { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })), consent: true },
    { messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(7000) })), consent: true },
    { messages: [], consent: true },
  ];
  for (const value of invalid) assert.equal((await f.post(value)).statusCode, 400);
  assert.equal((await f.post(body('x'.repeat(150_000)))).statusCode, 413);
  assert.equal(f.calls.length, 0);
});

test('upstream limits use safe retry hints and do not expose prompts, provider details or keys', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response(`SECRET ${KEY} prompt content`, { status: 429, headers: { 'Retry-After': '125' } }) });
  const response = await f.post();
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '125');
  assert.equal(response.json().code, 'AI_RATE_LIMIT');
  assert.ok(!response.body.includes('SECRET'));
  assert.ok(!response.body.includes(KEY));
});

test('provider errors, redirects and malformed or empty answers fail safely without fallback', async t => {
  for (const upstream of [
    () => new Response('private', { status: 401 }),
    () => new Response('private', { status: 402 }),
    () => new Response('private', { status: 302, headers: { Location: 'http://localhost/private' } }),
    () => new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }),
    () => good(''), () => good(' '), () => good('x'.repeat(16001)),
    () => new Response(JSON.stringify({ error: { message: 'private detail' } }), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { cost: 2 } }), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    let calls = 0;
    const f = await fixture(t, { fetchImpl: async () => { calls++; return upstream(); } });
    const response = await f.post();
    assert.ok([502, 503].includes(response.statusCode), `unexpected status ${response.statusCode}`);
    assert.equal(calls, 1);
    assert.ok(!response.body.includes('private'));
  }
});

test('deadline aborts a stalled provider and releases the per-user in-flight slot', async t => {
  let calls = 0; let signal;
  const f = await fixture(t, { timeoutMs: 15, fetchImpl: async (_url, init) => {
    signal = init.signal; calls++;
    if (calls === 1) return new Promise(() => {});
    return good('Следующий ответ');
  } });
  const response = await f.post();
  assert.equal(response.statusCode, 504);
  assert.equal(response.json().code, 'AI_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal((await f.post()).statusCode, 200);
});

test('oversized streamed provider output is canceled even without Content-Length', async t => {
  let canceled = false;
  const f = await fixture(t, { fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(70_000)); },
    cancel() { canceled = true; },
  }), { headers: { 'Content-Type': 'application/json' } }) });
  const response = await f.post();
  assert.equal(response.statusCode, 502);
  assert.equal(canceled, true);
});

test('per-user concurrency and six-per-minute limits are bounded and recover after the window', async t => {
  let now = 1_000; let release;
  const f = await fixture(t, { now: () => now, fetchImpl: async () => new Promise(resolve => { release = () => resolve(good()); }) });
  const first = f.post();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const concurrent = await f.post();
  assert.equal(concurrent.statusCode, 429);
  assert.equal(concurrent.json().code, 'AI_BUSY');
  release(); await first;
  for (let i = 0; i < 5; i++) {
    release = undefined; const pending = f.post();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release(); assert.equal((await pending).statusCode, 200);
  }
  const limited = await f.post();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '60');
  now += 60_000; release = undefined; const again = f.post();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); assert.equal((await again).statusCode, 200);
});

test('server configuration rejects invalid keys, deadlines, origins and dependencies before installing routes', async t => {
  const defaults = { authenticate: async () => {}, apiKey: KEY, now: () => 1000, fetchImpl: async () => good() };
  for (const override of [
    { authenticate: null }, { now: null }, { fetchImpl: false },
    { apiKey: 42 }, { apiKey: 'contains space' }, { apiKey: 'x'.repeat(513) },
    { timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: 1.5 },
    { allowedOrigins: 'https://example.invalid' }, { allowedOrigins: [42] },
  ]) {
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    assert.throws(() => registerAiRoutes(app, { ...defaults, ...override }));
    assert.equal(app.hasRoute({ method: 'POST', url: '/ai/chat' }), false);
  }
});

test('approved web origins work while invalid session subjects and query overrides remain blocked', async t => {
  const f = await fixture(t, { allowedOrigins: ['https://approved.example'] });
  assert.equal((await f.post(body(), { origin: 'https://approved.example' })).statusCode, 200);
  const queried = await f.app.inject({ method: 'GET', url: '/ai/status?model=paid', headers: { authorization: 'Bearer test-session' } });
  assert.equal(queried.statusCode, 400);
  const invalid = await fixture(t, { authenticate: async request => { request.auth = { user_id: null }; } });
  assert.equal((await invalid.post()).statusCode, 401);
  assert.equal(invalid.calls.length, 0);
  const sent = await fixture(t, { authenticate: async (_request, reply) => reply.code(401).send({ error: 'Denied by session hook' }) });
  assert.equal((await sent.post()).statusCode, 401);
  assert.equal(sent.calls.length, 0);
});

test('exact text/history boundaries and valid text responses without a cost field remain supported', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify({
    model: 'example/free', choices: [{ message: { role: 'assistant', content: 'x'.repeat(16_000) }, finish_reason: 'length' }],
  }), { headers: { 'Content-Type': 'application/json' } }) });
  for (const messages of [
    [{ role: 'user', content: 'x'.repeat(8000) }],
    Array.from({ length: 4 }, () => ({ role: 'user', content: 'x'.repeat(8000) })),
    Array.from({ length: 20 }, () => ({ role: 'user', content: 'x' })),
  ]) {
    const response = await f.post({ messages, consent: true });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().text.length, 16_000);
  }
});

test('malformed provider envelopes, headers, model IDs and tool responses are rejected', async t => {
  const data = () => ({ model: 'example/model', choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }] });
  const cases = [
    null, [], { ...data(), choices: [] }, { ...data(), choices: [data().choices[0], data().choices[0]] },
    { ...data(), error: { message: 'Provider reported failure even with choices' } },
    { ...data(), choices: [null] },
    { ...data(), usage: { cost: '0' } },
    { ...data(), model: 'https://attacker.invalid/?secret=1' },
    { ...data(), model: 42 },
    { ...data(), choices: [{ message: { role: 'tool', content: 'tool result' }, finish_reason: 'stop' }] },
    { ...data(), choices: [{ message: { role: 'assistant', content: 'x', tool_calls: [{}] }, finish_reason: 'stop' }] },
    { ...data(), choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'tool_calls' }] },
    { ...data(), choices: [{ message: { role: 'assistant', content: '\ud800' }, finish_reason: 'stop' }] },
  ];
  for (const value of cases) {
    const f = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }) });
    assert.equal((await f.post()).statusCode, 502);
  }
  for (const headers of [
    { 'Content-Type': 'text/html' }, { 'Content-Type': 'application/json', 'Content-Length': '200000' },
    { 'Content-Type': 'application/json', 'Content-Length': 'not-a-length' },
  ]) {
    const f = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify(data()), { headers }) });
    assert.equal((await f.post()).statusCode, 502);
  }
});

test('safe provider retry bounds and timeouts are preserved for all response classes', async t => {
  const now = Date.UTC(2026, 0, 1);
  for (const [retry, expected] of [
    [undefined, '60'], ['invalid', '60'], ['0', '1'], ['9999999999', '86400'],
    [new Date(now + 120_000).toUTCString(), '120'], ['x'.repeat(129), '60'],
  ]) {
    const f = await fixture(t, { now: () => now, fetchImpl: async () => new Response(null, { status: 429, headers: retry ? { 'Retry-After': retry } : {} }) });
    const response = await f.post();
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], expected);
  }
  const timeout = await fixture(t, { fetchImpl: async () => new Response(null, { status: 504 }) });
  assert.equal((await timeout.post()).statusCode, 504);
});

test('global concurrency is bounded and shutdown aborts active provider calls', async t => {
  const signals = [];
  const f = await fixture(t, {
    authenticate: async request => { request.auth = { user_id: request.headers['x-user'] }; },
    fetchImpl: async (_url, init) => { signals.push(init.signal); return new Promise(() => {}); },
  });
  const pending = Array.from({ length: 4 }, (_, i) => f.post(body(), { 'x-user': `user-${i}` }));
  while (signals.length < 4) await new Promise(resolve => setImmediate(resolve));
  const fifth = await f.post(body(), { 'x-user': 'fifth-user' });
  assert.equal(fifth.statusCode, 503);
  assert.equal(fifth.json().code, 'AI_BUSY');
  await f.app.close();
  for (const response of await Promise.all(pending)) assert.equal(response.statusCode, 503);
  assert.ok(signals.every(signal => signal.aborted));
});

test('provider byte limits apply across chunks, accept the exact bound and require valid UTF-8', async t => {
  const json = JSON.stringify({ model: 'example/model', choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] });
  const bytes = new TextEncoder().encode(json + ' '.repeat(128 * 1024 - json.length));
  const exact = await fixture(t, { fetchImpl: async () => new Response(bytes, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } }) });
  assert.equal((await exact.post()).statusCode, 200);
  const overflow = new Uint8Array(bytes.length + 1); overflow.set(bytes); overflow[bytes.length] = 32;
  const large = await fixture(t, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(overflow.subarray(0, 70_000)); controller.enqueue(overflow.subarray(70_000)); controller.close();
  } }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal((await large.post()).statusCode, 502);
  const prefix = Buffer.from('{"model":"example/model","choices":[{"message":{"role":"assistant","content":"');
  const malformed = Buffer.concat([prefix, Buffer.from([255]), Buffer.from('"},"finish_reason":"stop"}]}')]);
  const invalid = await fixture(t, { fetchImpl: async () => new Response(malformed, { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal((await invalid.post()).statusCode, 502);
});

test('missing provider content type or body returns the same safe invalid-response code', async t => {
  for (const upstream of [
    () => new Response(new Uint8Array([123, 125])),
    () => new Response(null, { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const f = await fixture(t, { fetchImpl: async () => upstream() });
    const response = await f.post();
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, 'AI_INVALID_RESPONSE');
  }
});

test('valid configuration endpoints and short or maximum session IDs work without relaxing invalid-subject checks', async t => {
  for (const key of ['k', 'k'.repeat(512)]) {
    const f = await fixture(t, { apiKey: key, timeoutMs: 1 });
    assert.equal((await f.status()).json().configured, true);
  }
  for (const id of ['', 'x', 'x'.repeat(128), 'x'.repeat(129)]) {
    const f = await fixture(t, { authenticate: async request => { request.auth = { user_id: id }; } });
    assert.equal((await f.status()).statusCode, id.length >= 1 && id.length <= 128 ? 200 : 401);
  }
  const missing = await fixture(t, { authenticate: async () => {} });
  assert.equal((await missing.status()).statusCode, 401);
});

test('an early response disconnect or aborted request cancels the active provider operation', async t => {
  for (const event of ['close', 'aborted']) {
    let incoming, outgoing, signal, reached;
    const started = new Promise(resolve => { reached = resolve; });
    const f = await fixture(t, {
      onRequest: async (request, reply) => { incoming = request.raw; outgoing = reply.raw; },
      fetchImpl: async (_url, init) => { signal = init.signal; reached(); return new Promise(() => {}); },
    });
    const pending = f.post();
    await started;
    if (event === 'close') outgoing.emit('close'); else incoming.emit('aborted');
    assert.equal(signal.aborted, true);
    if (event === 'close') await assert.rejects(pending, { code: 'LIGHT_ECONNRESET' });
    else assert.equal((await pending).statusCode, 503);
  }
});


test('FreeLLMAPI provider: private service URL, model auto, OpenAI body without OpenRouter routing fields', async t => {
  const { aiProvider } = await import('../src/ai.js');
  const provider = aiProvider({ provider: 'freellmapi', baseUrl: 'http://freellmapi:3001/v1/' });
  assert.deepEqual(provider, { name: 'freellmapi', endpoint: 'http://freellmapi:3001/v1/chat/completions', model: 'auto' });
  assert.throws(() => aiProvider({ provider: 'freellmapi', baseUrl: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => aiProvider({ provider: 'freellmapi', baseUrl: 'https://user:pw@example.com/v1' }));
  assert.throws(() => aiProvider({ provider: 'other' }));
  assert.equal(aiProvider({ provider: 'freellmapi', baseUrl: 'https://ai.example.com/v1', model: 'auto:fast' }).model, 'auto:fast');

  const f = await fixture(t, {
    provider,
    // FreeLLMAPI reports no OpenRouter cost field; a non-zero-looking usage must not be rejected for this provider.
    fetchImpl: async (url, init) => { f.calls.push({ url, init }); return new Response(JSON.stringify({
      model: 'groq/llama-3.3-70b-versatile', choices: [{ message: { role: 'assistant', content: 'Привет!' }, finish_reason: 'stop' }], usage: { total_tokens: 12 },
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }); },
  });
  const status = (await f.status()).json();
  assert.equal(status.provider, 'freellmapi');
  assert.equal(status.model, 'auto');
  const response = await f.post();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().text, 'Привет!');
  assert.equal(response.json().provider, 'freellmapi');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://freellmapi:3001/v1/chat/completions');
  const sent = JSON.parse(f.calls[0].init.body);
  assert.equal(sent.model, 'auto');
  assert.equal(sent.provider, undefined);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
});

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=';
const jsonResponse = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } });

async function freellmapiFixture(t, handler) {
  const { aiProvider } = await import('../src/ai.js');
  const calls = [];
  const f = await fixture(t, {
    provider: aiProvider({ provider: 'freellmapi', baseUrl: 'http://freellmapi:3001/v1' }),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); },
  });
  const call = (method, url, payload) => f.app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: 'Bearer test-session' } });
  return { ...f, calls, call };
}

test('FreeLLMAPI: status advertises media, models list strips router entries, chat forwards model and vision image', async t => {
  const f = await freellmapiFixture(t, (url, init) => {
    if (url.endsWith('/models?execution_status=ready')) return jsonResponse({ data: [{ id: 'auto' }, { id: 'groq/llama-3.3-70b' }, { id: 'auto:coding' }, { id: 'bad id!' }, { id: 'google/gemini-2.5-flash' }] });
    const body = JSON.parse(init.body);
    return jsonResponse({ model: 'google/gemini-2.5-flash', choices: [{ message: { role: 'assistant', content: `модель ${body.model}` }, finish_reason: 'stop' }] }, { 'X-Routed-Via': 'google/gemini-2.5-flash' });
  });
  const status = (await f.status()).json();
  for (const name of ['image', 'video', 'speech', 'transcribe', 'vision', 'models']) assert.equal(status.capabilities[name].enabled, true, name);
  const models = (await f.call('GET', '/ai/models')).json();
  assert.deepEqual(models.models, ['groq/llama-3.3-70b', 'google/gemini-2.5-flash']);
  assert.ok(models.strategies.includes('fusion'));
  const image = `data:image/png;base64,${PNG_1x1}`;
  const response = await f.post({ ...body('Что на фото?'), model: 'auto:smart', image });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().text, 'модель auto:smart');
  assert.equal(response.json().routedVia, 'google/gemini-2.5-flash');
  const sent = JSON.parse(f.calls.at(-1).init.body);
  assert.deepEqual(sent.messages.at(-1).content, [{ type: 'text', text: 'Что на фото?' }, { type: 'image_url', image_url: { url: image } }]);
  assert.equal((await f.post({ ...body(), model: 'drop table' })).statusCode, 400);
  assert.equal((await f.post({ ...body(), image: 'data:image/png;base64,AAAA' })).statusCode, 400, 'bytes must really be an image');
  assert.equal((await f.post({ ...body(), image: `data:image/jpeg;base64,${PNG_1x1}` })).statusCode, 400, 'declared type must match bytes');
});

test('FreeLLMAPI: image, speech, transcription and video are validated end to end', async t => {
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 2)]);
  const f = await freellmapiFixture(t, (url, init) => {
    if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ b64_json: PNG_1x1 }] }, { 'X-Routed-Via': 'pollinations/flux' });
    if (url.endsWith('/audio/speech')) return new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });
    if (url.endsWith('/audio/transcriptions')) { assert.ok(init.body instanceof FormData); return jsonResponse({ text: 'Привет, это проверка' }); }
    if (url.endsWith('/videos/generations')) return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    return new Response('{}', { status: 404 });
  });
  assert.equal((await f.call('POST', '/ai/image', { prompt: 'кот' })).json().code, 'AI_CONSENT_REQUIRED');
  const image = await f.call('POST', '/ai/image', { prompt: 'кот в космосе', consent: true });
  assert.equal(image.statusCode, 200, image.body);
  assert.equal(image.json().mimeType, 'image/png');
  assert.equal(image.json().routedVia, 'pollinations/flux');
  const speech = await f.call('POST', '/ai/speech', { text: 'Привет', consent: true });
  assert.equal(speech.statusCode, 200, speech.body);
  assert.equal(speech.json().mimeType, 'audio/mpeg');
  const transcript = await f.call('POST', '/ai/transcribe', { audio: mp3.toString('base64'), consent: true });
  assert.equal(transcript.statusCode, 200, transcript.body);
  assert.equal(transcript.json().text, 'Привет, это проверка');
  assert.equal((await f.call('POST', '/ai/transcribe', { audio: Buffer.from('not audio').toString('base64'), consent: true })).statusCode, 400);
  const video = await f.call('POST', '/ai/video', { prompt: 'закат', consent: true, duration: 4 });
  assert.equal(video.statusCode, 200);
  assert.equal(video.headers['content-type'], 'video/mp4');
  assert.equal(video.rawPayload.length, mp4.length);
  assert.equal((await f.call('POST', '/ai/video', { prompt: 'x', consent: true, duration: 99 })).statusCode, 400);
});

test('media routes stay off for the OpenRouter provider and fail closed on a bad provider answer', async t => {
  const f = await fixture(t);
  for (const [url, payload] of [['/ai/image', { prompt: 'кот', consent: true }], ['/ai/speech', { text: 'привет', consent: true }]]) {
    const response = await f.app.inject({ method: 'POST', url, payload, headers: { authorization: 'Bearer test-session' } });
    assert.equal(response.json().code, 'AI_FEATURE_UNAVAILABLE');
  }
  assert.equal((await f.post({ ...body(), model: 'auto' })).statusCode, 400);
  const bad = await freellmapiFixture(t, () => jsonResponse({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
  assert.equal((await bad.call('POST', '/ai/image', { prompt: 'кот', consent: true })).statusCode, 502, 'non-raster output is rejected');
});
