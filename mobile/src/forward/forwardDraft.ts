// Telegram's forward: pick a chat, the chat opens with «Переслать сообщение» above the input, you may
// add a comment and press send. The pending forward lives here (memory only) so it survives the switch
// from the source chat to the target chat.
import { useSyncExternalStore } from 'react';
import type { Message } from '../types';

export type ForwardItem = { message: Pick<Message, 'text' | 'attachment' | 'senderId'>; author: string };
export type ForwardDraft = { chatId: string; items: ForwardItem[] };

let draft: ForwardDraft | null = null;
const listeners = new Set<() => void>();

export function setForwardDraft(next: ForwardDraft | null): void {
  draft = next;
  listeners.forEach(listener => listener());
}

export function useForwardDraft(chatId: string): ForwardDraft | null {
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => draft, () => draft);
  return current?.chatId === chatId ? current : null;
}
