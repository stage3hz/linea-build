// Message features that travel INSIDE the end-to-end encrypted body.
// The server stores and relays them as ordinary ciphertext and cannot tell a
// reply, an edit, a reaction or a pin from a normal message.
import type { Message } from './types';

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👎', '🎉', '🙏', '👏', '🤔', '💯'] as const;
export type Reaction = typeof REACTIONS[number];

export type ReplyRef = { clientId: string; senderId: string; preview: string };
export type MessageAction =
  | { type: 'edit'; target: string; text: string }
  | { type: 'delete'; target: string }
  | { type: 'react'; target: string; emoji: Reaction | null }
  | { type: 'pin'; target: string | null };
export type MessageMeta = { reply?: ReplyRef; forward?: { from: string }; action?: MessageAction };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number, allowEmpty = false) => typeof value === 'string' && value.length <= max && (allowEmpty || !!value.trim());

function validAction(value: unknown): value is MessageAction {
  if (!record(value)) return false;
  switch (value.type) {
    case 'edit': return only(value, ['type', 'target', 'text']) && typeof value.target === 'string' && uuid.test(value.target) && text(value.text, 8000);
    case 'delete': return only(value, ['type', 'target']) && typeof value.target === 'string' && uuid.test(value.target);
    case 'react': return only(value, ['type', 'target', 'emoji']) && typeof value.target === 'string' && uuid.test(value.target) && (value.emoji === null || (REACTIONS as readonly unknown[]).includes(value.emoji));
    case 'pin': return only(value, ['type', 'target']) && (value.target === null || (typeof value.target === 'string' && uuid.test(value.target)));
    default: return false;
  }
}

export function validMeta(value: unknown): value is MessageMeta {
  if (value === undefined) return true;
  if (!record(value) || !only(value, ['reply', 'forward', 'action']) || !Object.keys(value).length) return false;
  if (value.reply !== undefined) {
    const reply = value.reply;
    if (!record(reply) || !only(reply, ['clientId', 'senderId', 'preview']) || typeof reply.clientId !== 'string' || !uuid.test(reply.clientId) || typeof reply.senderId !== 'string' || !uuid.test(reply.senderId) || !text(reply.preview, 200, true)) return false;
  }
  if (value.forward !== undefined && (!record(value.forward) || !only(value.forward, ['from']) || !text(value.forward.from, 80))) return false;
  if (value.action !== undefined && (!validAction(value.action) || value.reply !== undefined || value.forward !== undefined)) return false;
  return true;
}

/** Readable text an older client (or a chat preview) shows for an action. */
export function actionFallback(action: MessageAction, targetText = ''): string {
  const quote = targetText.trim() ? ` «${targetText.trim().slice(0, 60)}»` : '';
  switch (action.type) {
    case 'edit': return `✏️ Изменено: ${action.text}`.slice(0, 8000);
    case 'delete': return '🗑 Сообщение удалено';
    case 'react': return action.emoji ? `${action.emoji} Реакция на сообщение${quote}` : `Реакция убрана${quote}`;
    case 'pin': return action.target ? `📌 Закреплено сообщение${quote}` : '📌 Сообщение откреплено';
  }
}

export const messageKey = (message: Pick<Message, 'senderId' | 'clientId'>) => `${message.senderId}:${message.clientId}`;
export const isAction = (message: Pick<Message, 'meta'>) => !!message.meta?.action;

export type ReactionSummary = { emoji: Reaction; count: number; mine: boolean };
export type ViewMessage = Message & { edited: boolean; reactions: ReactionSummary[] };
export type ChatView = { messages: ViewMessage[]; pinned: ViewMessage | null; byClientId: Map<string, ViewMessage> };

/**
 * Applies encrypted actions to the decrypted history, oldest first.
 * Only the author may edit or delete a message; each participant has at most
 * one reaction per message (the latest wins); the latest pin from either side wins.
 */
export function foldChat(messages: Message[], userId: string, hiddenForMe: ReadonlySet<string> = new Set()): ChatView {
  const ordered = [...messages].sort((a, b) => a.id - b.id);
  const content = new Map<string, Message>();
  const authorOf = new Map<string, string>();
  for (const message of ordered) if (!isAction(message)) { content.set(message.clientId, message); authorOf.set(message.clientId, message.senderId); }
  const edits = new Map<string, string>(), deleted = new Set<string>(), reactions = new Map<string, Map<string, Reaction>>();
  let pin: string | null = null;
  for (const message of ordered) {
    const action = message.meta?.action;
    if (!action || message.cryptoState !== 'decrypted') continue;
    if (action.type === 'pin') { pin = action.target; continue; }
    const author = authorOf.get(action.target);
    if (action.type === 'edit' || action.type === 'delete') {
      if (author !== message.senderId) continue; // only the author; unknown targets are ignored
      if (action.type === 'edit') edits.set(action.target, action.text); else deleted.add(action.target);
      continue;
    }
    if (!author) continue;
    const perUser = reactions.get(action.target) ?? new Map<string, Reaction>();
    if (action.emoji) perUser.set(message.senderId, action.emoji); else perUser.delete(message.senderId);
    reactions.set(action.target, perUser);
  }
  const view: ViewMessage[] = [];
  const byClientId = new Map<string, ViewMessage>();
  for (const message of content.values()) {
    if (deleted.has(message.clientId) || hiddenForMe.has(messageKey(message))) continue;
    const perUser = reactions.get(message.clientId);
    const summary = new Map<Reaction, ReactionSummary>();
    if (perUser) for (const [reactor, emoji] of perUser) {
      const item = summary.get(emoji) ?? { emoji, count: 0, mine: false };
      item.count++; if (reactor === userId) item.mine = true; summary.set(emoji, item);
    }
    const edit = edits.get(message.clientId);
    const item: ViewMessage = { ...message, ...(edit !== undefined ? { text: edit } : {}), edited: edit !== undefined, reactions: [...summary.values()].sort((a, b) => REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji)) };
    view.push(item); byClientId.set(message.clientId, item);
  }
  view.sort((a, b) => a.id - b.id);
  return { messages: view, pinned: pin ? byClientId.get(pin) ?? null : null, byClientId };
}

/** Plain-text one-line quote for a reply. */
export function replyPreview(message: Pick<Message, 'text' | 'attachment'>): string {
  const body = message.text.trim().replace(/\s+/g, ' ');
  if (body) return body.slice(0, 200);
  return message.attachment ? `📎 ${message.attachment.name}`.slice(0, 200) : '';
}
