// AI chat history: kept only on this device, inside the encrypted vault.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CryptoRuntime } from '../e2ee/runtime';
import { AI_ANSWER_LIMIT, AI_MESSAGE_LIMIT, storedTurns, type AITurn } from './conversation.ts';

export const AI_HISTORY_MAX = 60;
export type AIStoredConversation = { id: string; title: string; updatedAt: string; consent: boolean; turns: AITurn[] };

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function validTurn(value: unknown): value is AITurn {
  if (!record(value) || !Number.isSafeInteger(value.id) || typeof value.question !== 'string' || value.question.length > AI_MESSAGE_LIMIT) return false;
  if (!['complete', 'failed', 'cancelled'].includes(String(value.status))) return false;
  if (value.answer !== undefined && (!record(value.answer) || typeof value.answer.text !== 'string' || value.answer.text.length > AI_ANSWER_LIMIT || typeof value.answer.model !== 'string')) return false;
  return value.error === undefined || typeof value.error === 'string';
}
function validConversation(value: unknown): value is AIStoredConversation {
  return record(value) && typeof value.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value.id) && typeof value.title === 'string' && value.title.length <= 120
    && typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt)) && typeof value.consent === 'boolean'
    && Array.isArray(value.turns) && value.turns.length > 0 && value.turns.length <= 40 && value.turns.every(validTurn);
}

export function parseAIHistory(raw: string | null): AIStoredConversation[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(validConversation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, AI_HISTORY_MAX) : [];
  } catch { return []; }
}

export function conversationTitle(turns: readonly AITurn[]): string {
  const first = turns[0]?.question.replace(/^Помоги с задачей по коду\.[\s\S]*?Задача пользователя:\n/, '').replace(/\s+/g, ' ').trim() || 'Беседа';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/** Inserts or replaces a conversation and keeps the newest first. Empty conversations are not stored. */
export function upsertConversation(list: AIStoredConversation[], id: string, turns: readonly AITurn[], consent: boolean, now: string): AIStoredConversation[] {
  const rest = list.filter(item => item.id !== id);
  if (!turns.length) return rest;
  const entry: AIStoredConversation = { id, title: conversationTitle(turns), updatedAt: now, consent, turns: storedTurns(turns).slice(-40) };
  return [entry, ...rest].slice(0, AI_HISTORY_MAX);
}

export function useAIHistory(runtime: CryptoRuntime) {
  const [items, setItems] = useState<AIStoredConversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const current = useRef<AIStoredConversation[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    runtime.get().then(service => service.loadLocal('ai:v1')).then(raw => { if (live) { current.current = parseAIHistory(raw); setItems(current.current); } })
      .catch(() => {}).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [runtime]);
  const persist = useCallback((next: AIStoredConversation[]) => {
    current.current = next; setItems(next);
    queue.current = queue.current.then(async () => { await (await runtime.get()).storeLocal('ai:v1', JSON.stringify(next)); }).catch(() => {});
  }, [runtime]);
  const save = useCallback((id: string, turns: readonly AITurn[], consent: boolean) => {
    const existing = current.current.find(item => item.id === id);
    const stored = storedTurns(turns);
    if (existing && existing.consent === consent && JSON.stringify(existing.turns) === JSON.stringify(stored)) return;
    persist(upsertConversation(current.current, id, turns, consent, new Date().toISOString()));
  }, [persist]);
  const remove = useCallback((id: string) => persist(current.current.filter(item => item.id !== id)), [persist]);
  const clearAll = useCallback(() => persist([]), [persist]);
  return { items, loaded, save, remove, clearAll };
}
export type AIHistoryStore = ReturnType<typeof useAIHistory>;
