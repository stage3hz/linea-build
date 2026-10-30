// Message features that travel INSIDE the end-to-end encrypted body.
// The server stores and relays them as ordinary ciphertext and cannot tell a
// reply, an edit, a reaction or a pin from a normal message.
import type { Message } from './types';
import { attachmentLabel } from './voice/voice.ts';

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👎', '🎉', '🙏', '👏', '🤔', '💯', '😍', '🥰', '😁', '🤣', '😎', '🤯', '😱', '🤬', '🥺', '😭', '🤡', '💩', '👀', '💀', '🫡', '🤝', '✍️', '🙈', '😴', '🤗', '🍾', '💔', '⚡', '🏆', '🥶', '😈', '🫶', '✅', '❌', '👌'] as const;
export type Reaction = typeof REACTIONS[number];

export type ReplyRef = { clientId: string; senderId: string; preview: string };
export type MessageAction =
  | { type: 'edit'; target: string; text: string }
  | { type: 'delete'; target: string }
  | { type: 'react'; target: string; emoji: Reaction | null }
  | { type: 'pin'; target: string | null }
  | { type: 'vote'; target: string; options: number[] }
  // Call signalling travels inside the Signal ciphertext, so the SDP (with its DTLS fingerprint) is authenticated end to end.
  | { type: 'call'; call: string; step: 'offer' | 'answer' | 'end'; video?: boolean; sdp?: string; reason?: 'hangup' | 'declined' | 'busy' | 'missed' | 'failed' };
/** Several photos/videos sent together and shown as one grid. */
export type AlbumRef = { id: string; index: number; count: number };
export type Poll = { question: string; options: string[]; multiple: boolean };
export const POLL_LIMITS = { question: 255, option: 100, minOptions: 2, maxOptions: 10 } as const;
export type MessageMeta = { reply?: ReplyRef; forward?: { from: string }; action?: MessageAction; album?: AlbumRef; poll?: Poll };

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
    case 'vote': return only(value, ['type', 'target', 'options']) && typeof value.target === 'string' && uuid.test(value.target) && Array.isArray(value.options) && value.options.length <= POLL_LIMITS.maxOptions && value.options.every(index => Number.isInteger(index) && index >= 0 && index < POLL_LIMITS.maxOptions) && new Set(value.options).size === value.options.length;
    case 'call': return only(value, ['type', 'call', 'step', 'video', 'sdp', 'reason']) && typeof value.call === 'string' && uuid.test(value.call)
      && (value.step === 'offer' || value.step === 'answer' || value.step === 'end')
      && (value.video === undefined || typeof value.video === 'boolean')
      && (value.sdp === undefined || (typeof value.sdp === 'string' && value.sdp.length <= 60000 && value.sdp.startsWith('v=0')))
      && (value.step === 'end' ? value.sdp === undefined : typeof value.sdp === 'string')
      && (value.reason === undefined || ['hangup', 'declined', 'busy', 'missed', 'failed'].includes(value.reason as string));
    default: return false;
  }
}

export function validMeta(value: unknown): value is MessageMeta {
  if (value === undefined) return true;
  if (!record(value) || !only(value, ['reply', 'forward', 'action', 'album', 'poll']) || !Object.keys(value).length) return false;
  if (value.reply !== undefined) {
    const reply = value.reply;
    if (!record(reply) || !only(reply, ['clientId', 'senderId', 'preview']) || typeof reply.clientId !== 'string' || !uuid.test(reply.clientId) || typeof reply.senderId !== 'string' || !uuid.test(reply.senderId) || !text(reply.preview, 200, true)) return false;
  }
  if (value.forward !== undefined && (!record(value.forward) || !only(value.forward, ['from']) || !text(value.forward.from, 80))) return false;
  if (value.action !== undefined && (!validAction(value.action) || Object.keys(value).length !== 1)) return false;
  if (value.album !== undefined) {
    const album = value.album;
    if (!record(album) || !only(album, ['id', 'index', 'count']) || typeof album.id !== 'string' || !uuid.test(album.id) || !Number.isInteger(album.count) || (album.count as number) < 2 || (album.count as number) > 10 || !Number.isInteger(album.index) || (album.index as number) < 0 || (album.index as number) >= (album.count as number)) return false;
  }
  if (value.poll !== undefined) {
    const poll = value.poll;
    if (!record(poll) || !only(poll, ['question', 'options', 'multiple']) || !text(poll.question, POLL_LIMITS.question) || typeof poll.multiple !== 'boolean' || !Array.isArray(poll.options) || poll.options.length < POLL_LIMITS.minOptions || poll.options.length > POLL_LIMITS.maxOptions || !poll.options.every(option => text(option, POLL_LIMITS.option)) || value.album !== undefined) return false;
  }
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
    case 'vote': return action.options.length ? `🗳 Голос в опросе${quote}` : `Голос отменён${quote}`;
    case 'call': return action.step === 'offer' ? (action.video ? '📹 Видеозвонок' : '📞 Звонок') : action.step === 'answer' ? '📞 Звонок принят' : action.reason === 'declined' ? '📞 Звонок отклонён' : action.reason === 'missed' ? '📞 Пропущенный звонок' : '📞 Звонок завершён';
  }
}

export const messageKey = (message: Pick<Message, 'senderId' | 'clientId'>) => `${message.senderId}:${message.clientId}`;
export const isAction = (message: Pick<Message, 'meta'>) => !!message.meta?.action;

export type ReactionSummary = { emoji: Reaction; count: number; mine: boolean };
export type PollResults = { counts: number[]; mine: number[]; voters: number };
export type ViewMessage = Message & { edited: boolean; reactions: ReactionSummary[]; poll?: PollResults };
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
  const votes = new Map<string, Map<string, number[]>>();
  let pin: string | null = null;
  for (const message of ordered) {
    const action = message.meta?.action;
    if (!action || message.cryptoState !== 'decrypted') continue;
    if (action.type === 'call') continue;
    if (action.type === 'pin') { pin = action.target; continue; }
    const author = authorOf.get(action.target);
    if (action.type === 'edit' || action.type === 'delete') {
      if (author !== message.senderId) continue; // only the author; unknown targets are ignored
      if (action.type === 'edit') edits.set(action.target, action.text); else deleted.add(action.target);
      continue;
    }
    if (!author) continue;
    if (action.type === 'vote') {
      const poll = content.get(action.target)?.meta?.poll;
      if (!poll || action.options.some(index => index >= poll.options.length) || (!poll.multiple && action.options.length > 1)) continue;
      const perVoter = votes.get(action.target) ?? new Map<string, number[]>();
      if (action.options.length) perVoter.set(message.senderId, [...action.options].sort((a, b) => a - b)); else perVoter.delete(message.senderId);
      votes.set(action.target, perVoter);
      continue;
    }
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
    const poll = message.meta?.poll;
    if (poll) {
      const counts = poll.options.map(() => 0); let mine: number[] = [];
      const perVoter = votes.get(message.clientId);
      if (perVoter) for (const [voter, chosen] of perVoter) { for (const index of chosen) counts[index]++; if (voter === userId) mine = chosen; }
      item.poll = { counts, mine, voters: perVoter?.size ?? 0 };
    }
    view.push(item); byClientId.set(message.clientId, item);
  }
  view.sort((a, b) => a.id - b.id);
  return { messages: view, pinned: pin ? byClientId.get(pin) ?? null : null, byClientId };
}

/** Plain-text one-line quote for a reply. */
export function replyPreview(message: Pick<Message, 'text' | 'attachment' | 'meta'>): string {
  if (message.meta?.poll) return `📊 ${message.meta.poll.question}`.slice(0, 200);
  const body = message.text.trim().replace(/\s+/g, ' ');
  if (body) return body.slice(0, 200);
  return message.attachment ? attachmentLabel(message.attachment).slice(0, 200) : '';
}

/** Fallback text stored with a poll so a chat preview or an older client shows something readable. */
export function pollFallback(poll: Poll): string {
  return [`📊 ${poll.question}`, ...poll.options.map((option, index) => `${index + 1}. ${option}`)].join('\n').slice(0, 8000);
}

/** One message from Telegram's point of view = a single bubble; consecutive album parts join into one. */
export function groupAlbums<T extends { senderId: string; meta?: MessageMeta }>(items: T[]): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1], album = item.meta?.album;
    if (album && last && last[0].senderId === item.senderId && last[0].meta?.album?.id === album.id && last.length < album.count) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** Up to three emoji with no other text are shown large, as stickers. */
export function bigEmojiCount(value: string): number {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return 0;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
  const parts = Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed.replace(/\s+/g, ''))].map(part => part.segment) : Array.from(trimmed.replace(/\s+/g, ''));
  if (!parts.length || parts.length > 3) return 0;
  return parts.every(part => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(part) && !/[\p{L}\p{N}]/u.test(part.replace(/[\u{FE0F}\u{20E3}]/gu, ''))) ? parts.length : 0;
}
