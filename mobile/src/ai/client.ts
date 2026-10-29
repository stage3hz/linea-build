import type { Api } from '../api';
import { parseAIStatus, type AIAskOptions, type AIMessage } from './conversation';

export async function aiStatus(api: Api, signal: AbortSignal) {
  return parseAIStatus(await api.request<unknown>('/ai/status', { signal }));
}

export function aiQuestion(api: Api, messages: AIMessage[], signal: AbortSignal, options?: AIAskOptions) {
  return api.request<unknown>('/ai/chat', { method: 'POST', signal, body: JSON.stringify({ messages, consent: true, ...(options?.model ? { model: options.model } : {}), ...(options?.image ? { image: options.image } : {}) }) });
}

const record = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const base64 = (value: unknown) => typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

export async function aiModels(api: Api, signal?: AbortSignal): Promise<{ strategies: string[]; models: string[] }> {
  const data = record(await api.request<unknown>('/ai/models', { signal }));
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^[A-Za-z0-9_./:@+-]{1,200}$/.test(item)).slice(0, 300) : [];
  return { strategies: list(data?.strategies), models: list(data?.models) };
}

export type AIMediaResult = { mimeType: string; base64: string; routedVia?: string };
function mediaResult(value: unknown, kinds: RegExp): AIMediaResult {
  const data = record(value);
  if (!data || typeof data.mimeType !== 'string' || !kinds.test(data.mimeType) || !base64(data.base64)) throw new Error('AI-сервис вернул некорректный файл.');
  return { mimeType: data.mimeType, base64: data.base64 as string, ...(typeof data.routedVia === 'string' && data.routedVia.length <= 200 ? { routedVia: data.routedVia } : {}) };
}

export async function aiImage(api: Api, prompt: string, signal: AbortSignal): Promise<AIMediaResult> {
  return mediaResult(await api.request<unknown>('/ai/image', { method: 'POST', signal, body: JSON.stringify({ prompt, consent: true }) }), /^image\/(png|jpeg|webp)$/);
}

export async function aiSpeech(api: Api, text: string, voice: string, signal: AbortSignal): Promise<AIMediaResult> {
  return mediaResult(await api.request<unknown>('/ai/speech', { method: 'POST', signal, body: JSON.stringify({ text, voice, consent: true }) }), /^audio\/[a-z0-9.+-]+$/);
}

export async function aiTranscribe(api: Api, audioBase64: string, signal: AbortSignal): Promise<string> {
  const data = record(await api.request<unknown>('/ai/transcribe', { method: 'POST', signal, body: JSON.stringify({ audio: audioBase64, consent: true }) }));
  if (typeof data?.text !== 'string' || !data.text.trim()) throw new Error('AI-сервис не вернул текст расшифровки.');
  return data.text;
}

/** Video comes back as MP4 bytes; the caller writes them to a local file. */
export async function aiVideo(api: Api, prompt: string, duration: number, signal: AbortSignal): Promise<ArrayBuffer> {
  return api.binary('/ai/video', { method: 'POST', signal, body: JSON.stringify({ prompt, duration, consent: true }) }, 'video/mp4');
}
