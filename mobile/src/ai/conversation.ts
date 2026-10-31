export const AI_MESSAGE_LIMIT = 8000;
export const AI_HISTORY_LIMIT = 32000;
export const AI_MESSAGE_COUNT = 20;
export const AI_ANSWER_LIMIT = 16000;
export type AIMessage = { role: 'user' | 'assistant'; content: string };
export type AIProvider = 'openrouter' | 'freellmapi';
export type AIReply = { text: string; model: string; provider: AIProvider; freeOnly: true; routedVia?: string };
export type AIAskOptions = { model?: string; image?: string };
export type AICapabilityName = 'text' | 'code' | 'image' | 'video' | 'threeD' | 'social' | 'speech' | 'transcribe' | 'vision' | 'models';
export type AICapability = { enabled: boolean; reason?: string };
/** `platina`: full AI (model choice, code, photos, media). Without it — fast text answers only. Older servers: true. */
export type AIStatus = { configured: boolean; model: string; provider: AIProvider; freeOnly: true; platina: boolean; capabilities: Record<AICapabilityName, AICapability> };
const validModel = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_./:@+-]{1,200}$/.test(value);
// OpenRouter is pinned to its zero-price route; FreeLLMAPI is the administrator's self-hosted router of free-tier keys.
const validProvider = (provider: unknown, model: unknown): provider is AIProvider => (provider === 'openrouter' && model === 'openrouter/free') || (provider === 'freellmapi' && validModel(model));
export type AITurn = { id: number; question: string; status: 'pending' | 'complete' | 'failed' | 'cancelled'; answer?: AIReply; error?: string; options?: AIAskOptions };
export type AIState = { consent: boolean; pending: boolean; turns: AITurn[]; error: string };
type Transport = (messages: AIMessage[], signal: AbortSignal, options?: AIAskOptions) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI-сервис вернул некорректный ответ.');
  return value as Record<string, unknown>;
}

export function parseAIStatus(value: unknown): AIStatus {
  const status = record(value);
  if (typeof status.configured !== 'boolean' || !validProvider(status.provider, status.model) || status.freeOnly !== true) throw new Error('Этот сервер не подтвердил доступ к бесплатному AI.');
  const source = record(status.capabilities);
  const capability = (name: AICapabilityName): AICapability => {
    // Newer tools are optional so an older server simply reports them as unavailable.
    if (['speech', 'transcribe', 'vision', 'models'].includes(name) && source[name] === undefined) return { enabled: false, reason: 'Этот сервер пока не поддерживает инструмент.' };
    const entry = record(source[name]);
    if (typeof entry.enabled !== 'boolean' || (entry.reason !== undefined && typeof entry.reason !== 'string')) throw new Error('Сервер не подтвердил доступность AI-инструментов.');
    return { enabled: entry.enabled, reason: typeof entry.reason === 'string' ? entry.reason : undefined };
  };
  return { configured: status.configured, provider: status.provider as AIProvider, model: status.model as string, freeOnly: true, platina: status.platina !== false, capabilities: {
    text: capability('text'), code: capability('code'), image: capability('image'), video: capability('video'), threeD: capability('threeD'), social: capability('social'),
    speech: capability('speech'), transcribe: capability('transcribe'), vision: capability('vision'), models: capability('models'),
  } };
}

export function parseAIReply(value: unknown): AIReply {
  const reply = record(value);
  if (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > AI_ANSWER_LIMIT || typeof reply.model !== 'string' || !reply.model.trim() || reply.model.length > 240 || (reply.provider !== 'openrouter' && reply.provider !== 'freellmapi') || reply.freeOnly !== true) throw new Error('AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз.');
  const routedVia = typeof reply.routedVia === 'string' && reply.routedVia.length <= 200 ? reply.routedVia : undefined;
  return { text: reply.text, model: reply.model, provider: reply.provider as AIProvider, freeOnly: true, ...(routedVia ? { routedVia } : {}) };
}

/** Only successful turns of this AI conversation are eligible as context. */
export function historyForQuestion(turns: readonly AITurn[], question: string): AIMessage[] {
  const text = question.trim();
  if (!text) throw new Error('Напиши вопрос.');
  if (text.length > AI_MESSAGE_LIMIT) throw new Error(`Вопрос должен быть не длиннее ${AI_MESSAGE_LIMIT} символов.`);
  const messages: AIMessage[] = [];
  for (const turn of turns) {
    if (turn.status !== 'complete' || !turn.answer) continue;
    messages.push({ role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer.text });
  }
  messages.push({ role: 'user', content: text });
  if (messages.length > AI_MESSAGE_COUNT || messages.some(message => message.content.length > AI_MESSAGE_LIMIT) || messages.reduce((sum, message) => sum + message.content.length, 0) > AI_HISTORY_LIMIT) {
    throw new Error('Беседа достигла лимита контекста. Начни новую беседу — предыдущий текст не будет обрезан или отправлен частично.');
  }
  return messages;
}

export const CODE_TASK_PREFIX = 'Помоги с задачей по коду. Подготовь код или объяснение в виде текста; запуск кода и изменение файлов не запрашиваются.\n\nЗадача пользователя:\n';
export type CodeTaskPreview = { prompt: string; messages: AIMessage[] };

export function createCodeTaskPreview(turns: readonly AITurn[], description: string): CodeTaskPreview {
  if (!description.trim()) throw new Error('Опиши задачу по коду.');
  const prompt = CODE_TASK_PREFIX + description.trim();
  return { prompt, messages: historyForQuestion(turns, prompt) };
}

export function codePreviewCurrent(turns: readonly AITurn[], preview: CodeTaskPreview): boolean {
  try { return JSON.stringify(historyForQuestion(turns, preview.prompt)) === JSON.stringify(preview.messages); }
  catch { return false; }
}

const initial = (): AIState => ({ consent: false, pending: false, turns: [], error: '' });
const failureText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось получить ответ. Попробуй ещё раз.';

/** Memory only. The owner creates one instance per mounted screen/account. */
export class AIConversation {
  private transport: Transport;
  private state = initial();
  private listeners = new Set<() => void>();
  private revision = 0;
  private nextId = 0;
  private closed = false;
  private active: { revision: number; controller: AbortController; turnId: number } | null = null;

  constructor(transport: Transport) { this.transport = transport; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  setConsent(consent: boolean) {
    if (this.closed) return;
    if (!consent) this.cancel();
    this.publish({ ...this.state, consent, error: '' });
  }

  async ask(question: string, options?: AIAskOptions): Promise<void> {
    if (!this.canStart()) return;
    let messages: AIMessage[];
    try { messages = historyForQuestion(this.state.turns, question); }
    catch (error) { this.publish({ ...this.state, error: failureText(error) }); return; }
    const turn: AITurn = { id: ++this.nextId, question: question.trim(), status: 'pending', ...(options && (options.model || options.image) ? { options } : {}) };
    this.publish({ ...this.state, pending: true, turns: [...this.state.turns, turn], error: '' });
    await this.run(turn.id, messages, turn.options);
  }

  async retry(): Promise<void> {
    if (!this.canStart()) return;
    const turn = this.state.turns.at(-1);
    if (!turn || !['failed', 'cancelled'].includes(turn.status)) return;
    let messages: AIMessage[];
    try { messages = historyForQuestion(this.state.turns.slice(0, -1), turn.question); }
    catch (error) { this.publish({ ...this.state, error: failureText(error) }); return; }
    this.publish({ ...this.state, pending: true, error: '', turns: this.state.turns.map(item => item.id === turn.id ? { ...item, status: 'pending', error: undefined } : item) });
    await this.run(turn.id, messages, turn.options);
  }

  cancel() {
    const active = this.active;
    if (!active) return;
    this.active = null; this.revision += 1; active.controller.abort();
    this.publish({ ...this.state, pending: false, error: '', turns: this.state.turns.map(turn => turn.id === active.turnId ? { ...turn, status: 'cancelled', error: undefined } : turn) });
  }

  /** Reopens a stored conversation. Unfinished turns come back as cancelled. */
  restore(turns: AITurn[], consent: boolean) {
    if (this.closed) return;
    this.cancel();
    this.nextId = turns.reduce((max, turn) => Math.max(max, turn.id), 0);
    this.publish({ consent, pending: false, error: '', turns: storedTurns(turns) });
  }

  clear() {
    if (this.closed) return;
    this.cancel(); this.publish({ ...initial(), consent: this.state.consent });
  }

  close() {
    if (this.closed) return;
    this.cancel(); this.closed = true; this.publish(initial()); this.listeners.clear();
  }

  private canStart() {
    if (this.closed || this.state.pending) return false;
    if (this.state.consent) return true;
    this.publish({ ...this.state, error: 'Сначала разреши отправлять вопросы внешней AI-службе.' });
    return false;
  }

  private async run(turnId: number, messages: AIMessage[], options?: AIAskOptions) {
    const revision = ++this.revision, controller = new AbortController();
    this.active = { revision, controller, turnId };
    const current = () => !this.closed && this.state.consent && this.active?.revision === revision;
    try {
      const answer = parseAIReply(await this.transport(messages, controller.signal, options));
      if (!current()) return;
      this.active = null;
      this.publish({ ...this.state, pending: false, error: '', turns: this.state.turns.map(turn => turn.id === turnId ? { ...turn, status: 'complete', answer, error: undefined } : turn) });
    } catch (error) {
      if (!current()) return;
      this.active = null;
      const message = failureText(error);
      this.publish({ ...this.state, pending: false, error: message, turns: this.state.turns.map(turn => turn.id === turnId ? { ...turn, status: 'failed', error: message } : turn) });
    }
  }

  private publish(state: AIState) { this.state = state; for (const listener of this.listeners) listener(); }
}

// Stored history: turns without attached photos (they are large and already answered).
export function storedTurns(turns: readonly AITurn[]): AITurn[] {
  return turns.map(turn => {
    const model = turn.options?.model;
    const base: AITurn = { id: turn.id, question: turn.question, status: turn.status === 'pending' ? 'cancelled' : turn.status, ...(turn.answer ? { answer: turn.answer } : {}), ...(turn.error ? { error: turn.error } : {}), ...(model ? { options: { model } } : {}) };
    return base;
  });
}
