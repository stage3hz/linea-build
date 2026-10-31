const OPENROUTER = { name: 'openrouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free' };

/**
 * Server-only provider selection. 'openrouter' keeps the zero-price route.
 * 'freellmapi' is a self-hosted FreeLLMAPI router (OpenAI-compatible) that pools
 * the administrator's own free-tier provider keys. Plain HTTP is accepted only
 * for a private hostname such as the Docker service name.
 */
export function aiProvider({ provider = 'openrouter', baseUrl = '', model = '' } = {}) {
  if (provider === 'openrouter') return { ...OPENROUTER };
  if (provider !== 'freellmapi') throw new Error('Unknown AI provider');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid AI base URL'); }
  const privateHost = !url.hostname.includes('.') || ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost)) throw new Error('AI base URL must use HTTPS unless it is a private service name');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid AI base URL');
  const chosen = model || 'auto';
  if (!/^[A-Za-z0-9_./:@+-]{1,200}$/.test(chosen)) throw new Error('Invalid AI model');
  return { name: 'freellmapi', endpoint: `${url.origin}${url.pathname.replace(/\/+$/, '')}/chat/completions`, model: chosen };
}
const MAX_BODY = 128 * 1024;
const MAX_RESPONSE = 128 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 6;
const MAX_USERS = 10_000;
const MAX_CONCURRENT = 4;

class AiFailure extends Error {
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const unavailable = () => new AiFailure(503, 'AI_UNAVAILABLE', 'Бесплатная AI-модель сейчас недоступна. Повторите позже.');
const invalid = () => new AiFailure(400, 'AI_INVALID_REQUEST', 'Проверьте текст и историю: до 20 сообщений, 8000 символов в одном и 32000 в сумме.');
const badAnswer = () => new AiFailure(502, 'AI_INVALID_RESPONSE', 'Провайдер не вернул допустимый текстовый ответ. Повторите запрос.');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(value, allowed) {
  return record(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validText(value, maximum) {
  return typeof value === 'string' && value.isWellFormed() && value.length <= maximum &&
    !value.includes('\0') && Boolean(value.trim());
}

function messageFrom(message) {
  if (!onlyKeys(message, ['role', 'content']) || !['user', 'assistant'].includes(message.role)) throw invalid();
  if (!validText(message.content, 8000)) throw invalid();
  // Preserve intentional whitespace in source code and the approved prompt.
  return { role: message.role, content: message.content };
}

function historyFrom(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) throw invalid();
  return messages.map(messageFrom);
}

function messagesFrom(body) {
  if (!onlyKeys(body, ['messages', 'consent', 'model', 'image'])) throw invalid();
  if (body.consent !== true) throw new AiFailure(400, 'AI_CONSENT_REQUIRED', 'Сначала подтвердите передачу этой AI-переписки внешнему провайдеру.');
  const messages = historyFrom(body.messages);
  const characters = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (characters > 32_000) throw invalid();
  if (messages[0].role !== 'user' || messages.at(-1).role !== 'user') throw invalid();
  return messages;
}

function capabilities(configured, provider = OPENROUTER) {
  const disabled = 'AI не настроен: администратору нужен серверный ключ AI-провайдера.';
  const media = configured && provider.name === 'freellmapi';
  const viaRouter = 'Через FreeLLMAPI: работает, если в его панели добавлены ключи провайдеров с такими моделями.';
  return {
    text: { enabled: configured, ...(configured ? {} : { reason: disabled }) },
    code: { enabled: configured, reason: configured ? 'Генерация и объяснение кода. Выполнение кода не подключено.' : disabled },
    image: media ? { enabled: true, reason: viaRouter } : { enabled: false, reason: 'Провайдер генерации и редактирования изображений не подключён.' },
    video: media ? { enabled: true, reason: viaRouter } : { enabled: false, reason: 'AI-генерация и AI-монтаж видео не подключены.' },
    speech: media ? { enabled: true, reason: viaRouter } : { enabled: false, reason: 'Озвучка текста не подключена.' },
    transcribe: media ? { enabled: true, reason: viaRouter } : { enabled: false, reason: 'Расшифровка аудио не подключена.' },
    vision: media ? { enabled: true, reason: viaRouter } : { enabled: false, reason: 'Вопросы по фото не подключены.' },
    models: media ? { enabled: true } : { enabled: false, reason: 'Выбор модели доступен с FreeLLMAPI.' },
    threeD: { enabled: false, reason: 'Генерация и редактирование 3D-моделей не подключены.' },
    social: { enabled: false, reason: 'Исполнитель задач в соцсетях не подключён. Публикации и действия недоступны.' },
  };
}

function retryAfter(value, now) {
  if (typeof value !== 'string' || value.length > 128) return 60;
  const seconds = /^\d{1,10}$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86_400, Math.ceil(seconds))) : 60;
}

function responseFailure(response, now) {
  if (response.status === 429) return new AiFailure(429, 'AI_RATE_LIMIT', 'Лимит бесплатного AI исчерпан. Повторите позже.', retryAfter(response.headers.get('Retry-After'), now));
  if ([408, 504].includes(response.status)) return new AiFailure(504, 'AI_TIMEOUT', 'AI не успел ответить. Повторите позже.');
  if ([401, 402, 403].includes(response.status)) return new AiFailure(503, 'AI_PROVIDER_UNAVAILABLE', 'AI недоступен с текущими настройками провайдера. Обратитесь к администратору.');
  return unavailable();
}

function excessiveLength(length, maximum = MAX_RESPONSE) {
  if (length === null) return false;
  return !/^\d+$/.test(length) || Number(length) > maximum;
}

function checkResponseHeaders(response, maximum = MAX_RESPONSE) {
  const length = response.headers.get('Content-Length');
  const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' || excessiveLength(length, maximum) || !response.body?.getReader) {
    response.body?.cancel().catch(() => {});
    throw badAnswer();
  }
}

async function boundedJson(response, maximum = MAX_RESPONSE) {
  checkResponseHeaders(response, maximum);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || bytes + value.byteLength > maximum) throw badAnswer();
      bytes += value.byteLength;
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    reader.cancel().catch(() => {});
    throw badAnswer();
  } finally {
    reader.releaseLock();
  }
}

function singleChoice(data) {
  if (!record(data) || data.error || !Array.isArray(data.choices) || data.choices.length !== 1) throw badAnswer();
  return data.choices[0];
}

function checkZeroCost(cost) {
  if (cost === undefined) return;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost !== 0) throw badAnswer();
}

function assistantText(choice) {
  const message = choice?.message;
  if (!record(message) || message.role !== 'assistant' || message.tool_calls?.length ||
      !['stop', 'length'].includes(choice.finish_reason)) throw badAnswer();
  if (!validText(message.content, 16_000)) throw badAnswer();
  return message.content;
}

function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./:@+-]{1,200}$/.test(value)) throw badAnswer();
  return value;
}

function routedVia(response) {
  const raw = response.headers.get('X-Routed-Via');
  if (typeof raw !== 'string' || raw.length > 300) return undefined;
  try { const value = decodeURIComponent(raw); return /^[\p{L}\p{N}_./:@+\- ]{1,200}$/u.test(value) ? value : undefined; } catch { return undefined; }
}

function answerFrom(data, provider, via) {
  const choice = singleChoice(data);
  if (provider.name === 'openrouter') checkZeroCost(data.usage?.cost);
  return { text: assistantText(choice), model: modelId(data.model), provider: provider.name, freeOnly: true, ...(via ? { routedVia: via } : {}) };
}

async function completion(messages, key, fetchImpl, controller, now, provider, options = {}) {
  const body = provider.name === 'openrouter'
    ? {
      model: provider.model, messages, stream: false, max_tokens: 2048,
      provider: {
        data_collection: 'deny', zdr: true, require_parameters: true,
        max_price: { prompt: 0, completion: 0, request: 0 },
        // Fallbacks remain inside the same zero-price/privacy-filtered model route.
        allow_fallbacks: true,
      },
    }
    // FreeLLMAPI routes 'auto' across the administrator's free-tier keys and fails over on rate limits.
    : { model: options.model || provider.model, messages: withImage(messages, options.image), stream: false, max_tokens: 2048 };
  const response = await fetchImpl(provider.endpoint, {
    method: 'POST', redirect: 'error', signal: controller.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw responseFailure(response, now);
  }
  return answerFrom(await boundedJson(response), provider, routedVia(response));
}

async function withDeadline(operation, controller, timeoutMs) {
  let timer;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason instanceof AiFailure ? controller.signal.reason : unavailable());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new AiFailure(504, 'AI_TIMEOUT', 'AI не успел ответить за минуту. Повторите позже.')), timeoutMs);
  });
  try {
    if (controller.signal.aborted) throw unavailable();
    return await Promise.race([operation(), stopped]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function sendFailure(reply, error) {
  const safe = error instanceof AiFailure ? error : unavailable();
  if (safe.retryAfterSeconds) reply.header('Retry-After', String(safe.retryAfterSeconds));
  return reply.code(safe.status).send({
    error: safe.message, code: safe.code,
    ...(safe.retryAfterSeconds ? { retryAfterSeconds: safe.retryAfterSeconds } : {}),
  });
}

function checkDependencies(authenticate, fetchImpl, now) {
  if (![authenticate, fetchImpl, now].every(value => typeof value === 'function')) throw new Error('AI route dependencies are required');
}

function checkKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey)) throw new Error('Invalid server AI key configuration');
}

function checkDeadline(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid AI deadline');
}

function originSet(allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => typeof origin !== 'string')) throw new Error('Invalid AI origin configuration');
  return new Set(allowedOrigins);
}

function validSessionSubject(id) {
  return ['string', 'number'].includes(typeof id) && String(id).length >= 1 && String(id).length <= 128;
}

function allowedOrigin(origin, origins) {
  return origin === undefined || (typeof origin === 'string' && origins.has(origin));
}

function accessGuard(authenticate, origins) {
  return async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    await authenticate(request, reply);
    if (reply.sent) return reply;
    if (!validSessionSubject(request.auth?.user_id)) {
      return sendFailure(reply, new AiFailure(401, 'AI_AUTH_REQUIRED', 'Войдите в аккаунт заново.'));
    }
    if (!allowedOrigin(request.headers.origin, origins)) {
      return sendFailure(reply, new AiFailure(403, 'AI_ORIGIN_REJECTED', 'Этот источник запросов не разрешён.'));
    }
    if (Object.keys(request.query || {}).length) return sendFailure(reply, invalid());
  };
}

class AiBudget {
  constructor(now) {
    this.now = now;
    this.windows = new Map();
    this.inFlight = new Map();
  }

  sweep(time) {
    for (const [id, entry] of this.windows) if (entry.until <= time) this.windows.delete(id);
  }

  bucketFor(userId, time) {
    const current = this.windows.get(userId);
    if (current && current.until > time) return current;
    if (this.windows.size >= MAX_USERS) this.sweep(time);
    if (this.windows.size >= MAX_USERS && !this.windows.has(userId)) throw new AiFailure(503, 'AI_BUSY', 'AI-сервер занят. Повторите позже.', 60);
    const bucket = { count: 0, until: time + WINDOW_MS };
    this.windows.set(userId, bucket);
    return bucket;
  }

  reserve(userId) {
    if (this.inFlight.has(userId)) throw new AiFailure(429, 'AI_BUSY', 'Дождитесь ответа на предыдущий AI-запрос.', 5);
    if (this.inFlight.size >= MAX_CONCURRENT) throw new AiFailure(503, 'AI_BUSY', 'AI-сервер занят. Повторите через несколько секунд.', 5);
    const time = this.now();
    const bucket = this.bucketFor(userId, time);
    if (bucket.count >= MAX_REQUESTS) throw new AiFailure(429, 'AI_RATE_LIMIT', 'Не более шести AI-запросов в минуту. Повторите позже.', Math.max(1, Math.ceil((bucket.until - time) / 1000)));
    bucket.count++;
    const controller = new AbortController();
    this.inFlight.set(userId, controller);
    return controller;
  }

  release(userId, controller) {
    if (controller && this.inFlight.get(userId) === controller) this.inFlight.delete(userId);
  }

  abortAll() {
    for (const controller of this.inFlight.values()) controller.abort();
    this.windows.clear();
  }
}

const platinaRequired = () => new AiFailure(403, 'AI_PLATINA_REQUIRED', 'Эта возможность AI доступна с Инвиз Platina. Без неё — быстрые ответы.');

function chatHandler({ apiKey, configured, fetchImpl, now, timeoutMs, provider, isPlatina }, budget) {
  return async (request, reply) => {
    let controller;
    const userId = String(request.auth.user_id);
    const abort = () => controller?.abort();
    const disconnected = () => { if (!reply.raw.writableEnded) abort(); };
    try {
      const messages = messagesFrom(request.body);
      const options = chatOptions(request.body, provider);
      // Without Platina: fast answers only — no model choice, no photo questions.
      if (!isPlatina(userId)) {
        if (options.model !== undefined || options.image !== undefined) throw platinaRequired();
        if (provider.name === 'freellmapi') options.model = 'auto:fast';
      }
      if (!configured) throw new AiFailure(503, 'AI_NOT_CONFIGURED', 'AI ещё не настроен. Администратору нужен серверный ключ AI-провайдера.');
      controller = budget.reserve(userId);
      request.raw.once('aborted', abort);
      reply.raw.once('close', disconnected);
      return await withDeadline(() => completion(messages, apiKey, fetchImpl, controller, now, provider, options), controller, timeoutMs);
    } catch (error) {
      controller?.abort();
      return sendFailure(reply, error);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', disconnected);
      budget.release(userId, controller);
    }
  };
}

/** Server-only configuration. Client input cannot select keys, models or URLs. */
export function registerAiRoutes(app, {
  authenticate,
  apiKey = '',
  provider = aiProvider(),
  allowedOrigins = [],
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 60_000,
  // Full AI (model choice, photos, images, speech, video) is a Platina feature; tests default to full.
  isPlatina = () => true,
} = {}) {
  checkDependencies(authenticate, fetchImpl, now);
  checkKey(apiKey);
  checkDeadline(timeoutMs);
  const access = accessGuard(authenticate, originSet(allowedOrigins));
  const budget = new AiBudget(now);
  const configured = apiKey.length > 0;
  app.get('/ai/status', { preHandler: access, logLevel: 'silent' }, async request => ({
    configured, provider: provider.name, model: provider.model, freeOnly: true, capabilities: capabilities(configured, provider),
    platina: isPlatina(String(request.auth.user_id)),
  }));
  app.post('/ai/chat', { preHandler: access, bodyLimit: provider.name === 'freellmapi' ? MAX_IMAGE_BODY : MAX_BODY, logLevel: 'silent' },
    chatHandler({ apiKey, configured, fetchImpl, now, timeoutMs, provider, isPlatina }, budget));
  registerMediaRoutes(app, { access: platinaAccess(access, isPlatina), budget, apiKey, configured, fetchImpl, now, provider });
  app.addHook('preClose', async () => budget.abortAll());
}

/** Media routes and the model list: signed in AND Platina. */
function platinaAccess(access, isPlatina) {
  return async (request, reply) => {
    await access(request, reply);
    if (reply.sent) return reply;
    if (!isPlatina(String(request.auth.user_id))) return sendFailure(reply, platinaRequired());
  };
}

// ---------------------------------------------------------------------------
// FreeLLMAPI surfaces: model choice, vision, images, speech, transcription, video.
// Only the self-hosted router is called; clients never pick a URL or a key.
// ---------------------------------------------------------------------------
const MAX_IMAGE_BODY = 6 * 1024 * 1024;
const MAX_AUDIO_BODY = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_GENERATED_IMAGE = 10 * 1024 * 1024;
const MAX_SPEECH = 10 * 1024 * 1024;
const MAX_VIDEO = 30 * 1024 * 1024;
export const AI_STRATEGIES = ['auto', 'auto:smart', 'auto:fast', 'auto:reliable', 'auto:balanced', 'fusion'];
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const featureOff = () => new AiFailure(503, 'AI_FEATURE_UNAVAILABLE', 'Эта AI-функция доступна, когда сервер подключён к FreeLLMAPI.');
const notConfigured = () => new AiFailure(503, 'AI_NOT_CONFIGURED', 'AI ещё не настроен. Администратору нужен серверный ключ AI-провайдера.');
const mediaInvalid = message => new AiFailure(400, 'AI_INVALID_REQUEST', message);

function chatOptions(body, provider) {
  const { model, image } = body;
  if (model === undefined && image === undefined) return {};
  // The OpenRouter route is pinned to its zero-price model: a client-chosen model stays a 400.
  if (provider.name !== 'freellmapi') throw invalid();
  const options = {};
  if (model !== undefined) {
    if (typeof model !== 'string' || !(AI_STRATEGIES.includes(model) || /^[A-Za-z0-9_./:@+-]{1,200}$/.test(model))) throw mediaInvalid('Неизвестная модель.');
    options.model = model;
  }
  if (image !== undefined) options.image = dataImage(image);
  return options;
}

function dataImage(value) {
  const match = typeof value === 'string' && value.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40 ? DATA_IMAGE.exec(value) : null;
  if (!match) throw mediaInvalid('Фото для вопроса: PNG, JPEG или WebP до 4 МБ.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || sniffImage(bytes) !== `image/${match[1]}`) throw mediaInvalid('Фото для вопроса повреждено или не соответствует формату.');
  return value;
}

function withImage(messages, image) {
  if (!image) return messages;
  const last = messages.at(-1);
  return [...messages.slice(0, -1), { role: 'user', content: [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: image } }] }];
}

function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function sniffAudio(bytes) {
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  return null;
}

function isMp4(bytes) { return bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp'; }

async function boundedBytes(response, maximum) {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { response.body?.cancel().catch(() => {}); throw badAnswer(); }
  if (!response.body?.getReader) throw badAnswer();
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || bytes + value.byteLength > maximum) throw badAnswer();
      bytes += value.byteLength; chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) { reader.cancel().catch(() => {}); throw error instanceof AiFailure ? error : badAnswer(); }
  finally { reader.releaseLock(); }
}

function routerUrl(provider, path) { return provider.endpoint.replace(/\/chat\/completions$/, path); }

async function routerCall(provider, key, fetchImpl, controller, now, path, init) {
  const response = await fetchImpl(routerUrl(provider, path), {
    redirect: 'error', signal: controller.signal, ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) },
  });
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    if (response.status === 422) throw new AiFailure(422, 'AI_NO_MODEL', 'В FreeLLMAPI не включено ни одной модели для этой задачи. Добавьте ключ подходящего провайдера в панели.');
    throw responseFailure(response, now);
  }
  return response;
}

function consentRequired(body) {
  if (!record(body) || body.consent !== true) throw new AiFailure(400, 'AI_CONSENT_REQUIRED', 'Сначала подтвердите передачу этого запроса внешнему AI-провайдеру.');
}

function mediaHandler({ budget, configured, provider, deadline }, work) {
  return async (request, reply) => {
    let controller;
    const userId = String(request.auth.user_id);
    const abort = () => controller?.abort();
    const disconnected = () => { if (!reply.raw.writableEnded) abort(); };
    try {
      if (provider.name !== 'freellmapi') throw featureOff();
      consentRequired(request.body);
      const input = work.parse(request.body);
      if (!configured) throw notConfigured();
      controller = budget.reserve(userId);
      request.raw.once('aborted', abort);
      reply.raw.once('close', disconnected);
      const result = await withDeadline(() => work.run(input, controller), controller, deadline);
      if (result && result.binary) return reply.type(result.mimeType).header('Content-Length', result.binary.length).send(result.binary);
      return result;
    } catch (error) {
      controller?.abort();
      return sendFailure(reply, error);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', disconnected);
      budget.release(userId, controller);
    }
  };
}

function registerMediaRoutes(app, { access, budget, apiKey, configured, fetchImpl, now, provider }) {
  const call = (controller, path, init) => routerCall(provider, apiKey, fetchImpl, controller, now, path, init);
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  app.get('/ai/models', { preHandler: access, logLevel: 'silent' }, async (request, reply) => {
    try {
      if (provider.name !== 'freellmapi') throw featureOff();
      if (!configured) throw notConfigured();
      const controller = new AbortController();
      const response = await withDeadline(() => call(controller, '/models?execution_status=ready', { method: 'GET', headers: { Accept: 'application/json' } }), controller, 15_000);
      const data = await boundedJson(response, 4 * 1024 * 1024);
      const list = Array.isArray(data?.data) ? data.data : [];
      const models = list.map(item => item?.id).filter(id => typeof id === 'string' && /^[A-Za-z0-9_./:@+-]{1,200}$/.test(id) && !AI_STRATEGIES.includes(id) && !id.startsWith('auto:')).slice(0, 300);
      return { strategies: AI_STRATEGIES, models: [...new Set(models)] };
    } catch (error) { return sendFailure(reply, error); }
  });

  app.post('/ai/image', { preHandler: access, bodyLimit: 32 * 1024, logLevel: 'silent' }, mediaHandler({ budget, configured, provider, deadline: 120_000 }, {
    parse(body) {
      if (!onlyKeys(body, ['prompt', 'consent', 'size'])) throw invalid();
      if (!validText(body.prompt, 4000)) throw mediaInvalid('Опишите картинку: до 4000 символов.');
      if (body.size !== undefined && !['1024x1024', '1024x1792', '1792x1024', '512x512'].includes(body.size)) throw mediaInvalid('Неизвестный размер картинки.');
      return { prompt: body.prompt, size: body.size || '1024x1024' };
    },
    async run({ prompt, size }, controller) {
      const response = await call(controller, '/images/generations', json({ model: 'auto', prompt, n: 1, size, response_format: 'b64_json' }));
      const via = routedVia(response);
      const data = await boundedJson(response, Math.ceil(MAX_GENERATED_IMAGE / 3) * 4 + 64 * 1024).catch(() => { throw badAnswer(); });
      const item = Array.isArray(data?.data) ? data.data[0] : null;
      let bytes;
      if (typeof item?.b64_json === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)) bytes = Buffer.from(item.b64_json, 'base64');
      else if (typeof item?.url === 'string' && /^https:\/\//.test(item.url)) {
        const file = await fetchImpl(item.url, { redirect: 'error', signal: controller.signal });
        if (!file.ok) { file.body?.cancel().catch(() => {}); throw badAnswer(); }
        bytes = await boundedBytes(file, MAX_GENERATED_IMAGE);
      } else throw badAnswer();
      const mimeType = sniffImage(bytes);
      if (!mimeType || bytes.length > MAX_GENERATED_IMAGE) throw badAnswer();
      return { mimeType, base64: bytes.toString('base64'), ...(via ? { routedVia: via } : {}) };
    },
  }));

  app.post('/ai/speech', { preHandler: access, bodyLimit: 32 * 1024, logLevel: 'silent' }, mediaHandler({ budget, configured, provider, deadline: 60_000 }, {
    parse(body) {
      if (!onlyKeys(body, ['text', 'consent', 'voice'])) throw invalid();
      if (!validText(body.text, 4000)) throw mediaInvalid('Текст для озвучки: до 4000 символов.');
      if (body.voice !== undefined && !['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(body.voice)) throw mediaInvalid('Неизвестный голос.');
      return { text: body.text, voice: body.voice || 'alloy' };
    },
    async run({ text, voice }, controller) {
      const response = await call(controller, '/audio/speech', json({ model: 'auto', input: text, voice, response_format: 'mp3' }));
      const bytes = await boundedBytes(response, MAX_SPEECH);
      const mimeType = sniffAudio(bytes);
      if (!mimeType) throw badAnswer();
      return { mimeType, base64: bytes.toString('base64') };
    },
  }));

  app.post('/ai/transcribe', { preHandler: access, bodyLimit: MAX_AUDIO_BODY, logLevel: 'silent' }, mediaHandler({ budget, configured, provider, deadline: 120_000 }, {
    parse(body) {
      if (!onlyKeys(body, ['audio', 'consent', 'name'])) throw invalid();
      if (typeof body.audio !== 'string' || body.audio.length > Math.ceil(10 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) throw mediaInvalid('Аудио для расшифровки: до 10 МБ.');
      const bytes = Buffer.from(body.audio, 'base64');
      const mimeType = sniffAudio(bytes);
      if (!mimeType) throw mediaInvalid('Поддерживаются MP3, M4A, WAV, OGG, FLAC и WebM.');
      return { bytes, mimeType };
    },
    async run({ bytes, mimeType }, controller) {
      const form = new FormData();
      const extension = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/webm': 'webm' }[mimeType];
      form.append('file', new Blob([bytes], { type: mimeType }), `audio.${extension}`);
      form.append('model', 'auto');
      const response = await call(controller, '/audio/transcriptions', { method: 'POST', body: form });
      const data = await boundedJson(response).catch(() => { throw badAnswer(); });
      if (!validText(data?.text, 100_000)) throw badAnswer();
      return { text: data.text };
    },
  }));

  app.post('/ai/video', { preHandler: access, bodyLimit: 32 * 1024, logLevel: 'silent' }, mediaHandler({ budget, configured, provider, deadline: 330_000 }, {
    parse(body) {
      if (!onlyKeys(body, ['prompt', 'consent', 'duration'])) throw invalid();
      if (!validText(body.prompt, 2000)) throw mediaInvalid('Опишите видео: до 2000 символов.');
      if (body.duration !== undefined && !(Number.isInteger(body.duration) && body.duration >= 2 && body.duration <= 10)) throw mediaInvalid('Длительность видео: от 2 до 10 секунд.');
      return { prompt: body.prompt, duration: body.duration || 5 };
    },
    async run({ prompt, duration }, controller) {
      const response = await call(controller, '/videos/generations', json({ model: 'auto', prompt, duration }));
      const bytes = await boundedBytes(response, MAX_VIDEO);
      if (!isMp4(bytes)) throw badAnswer();
      return { binary: bytes, mimeType: 'video/mp4' };
    },
  }));
}
