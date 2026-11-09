// Message features that travel INSIDE the end-to-end encrypted body.
// The server stores and relays them as ordinary ciphertext and cannot tell a
// reply, an edit, a reaction or a pin from a normal message.
import type { Message } from './types';
import { attachmentLabel } from './voice/voice.ts';
import { maskSpoilers, validEntities, type Entity } from './format/entities.ts';
import { formatCallDuration } from './calls/callModel.ts';

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👎', '🎉', '🙏', '👏', '🤔', '💯', '😍', '🥰', '😁', '🤣', '😎', '🤯', '😱', '🤬', '🥺', '😭', '🤡', '💩', '👀', '💀', '🫡', '🤝', '✍️', '🙈', '😴', '🤗', '🍾', '💔', '⚡', '🏆', '🥶', '😈', '🫶', '✅', '❌', '👌'] as const;
export type Reaction = typeof REACTIONS[number];

export type ReplyRef = { clientId: string; senderId: string; preview: string };
export type MessageAction =
  // `entities` (bold, spoiler, …) ride along with the new text, as with a normal message.
  | { type: 'edit'; target: string; text: string; entities?: Entity[] }
  | { type: 'delete'; target: string }
  | { type: 'react'; target: string; emoji: Reaction | null }
  | { type: 'pin'; target: string | null }
  | { type: 'vote'; target: string; options: number[] }
  // Call signalling travels inside the Signal ciphertext, so the SDP (with its DTLS fingerprint) is authenticated end to end.
  // The `end` also carries the outcome both phones render as the service row «Исходящий звонок · 3:12» (F9):
  // `duration` in whole seconds (answered calls), `caller` — the sender of this `end` placed the call.
  | { type: 'call'; call: string; step: 'offer' | 'answer' | 'end'; video?: boolean; sdp?: string; reason?: 'hangup' | 'declined' | 'busy' | 'missed' | 'failed'; duration?: number; caller?: boolean }
  // Chat rules both sides follow: auto-delete after `ttl` seconds (0 = off) and no copying/forwarding.
  | { type: 'settings'; ttl: number; noCopy: boolean }
  // «Очистить историю» for both: everything sent before this action disappears on both phones.
  | { type: 'clear' };
export const AUTO_DELETE = [0, 86400, 604800, 2592000] as const;
export const autoDeleteLabel = (ttl: number) => ttl === 86400 ? '1 день' : ttl === 604800 ? '1 неделя' : ttl === 2592000 ? '1 месяц' : 'Выкл.';
export type ChatRules = { ttl: number; noCopy: boolean };
/** Several photos/videos sent together and shown as one grid. */
export type AlbumRef = { id: string; index: number; count: number };
export type Poll = { question: string; options: string[]; multiple: boolean };
export const POLL_LIMITS = { question: 255, option: 100, minOptions: 2, maxOptions: 10 } as const;
/** Formatting of `text` (Telegram entities, offsets in UTF-16 code units). The plain text stays readable for a client that ignores it. */
export type { Entity } from './format/entities.ts';
/** An answer to a friend's story (F8): the chat shows a quote «История», a tap opens the author's stories. */
export type StoryRef = { id: string; ownerId: string };
/** F4 «Отправить без звука»: `silent` travels inside the ciphertext for the UI (the server only sees the quiet push kind); the message is still unread for the peer. */
export type MessageMeta = { reply?: ReplyRef; forward?: { from: string }; action?: MessageAction; album?: AlbumRef; poll?: Poll; entities?: Entity[]; story?: StoryRef; silent?: true };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number, allowEmpty = false) => typeof value === 'string' && value.length <= max && (allowEmpty || !!value.trim());

function validAction(value: unknown): value is MessageAction {
  if (!record(value)) return false;
  switch (value.type) {
    case 'edit': return only(value, ['type', 'target', 'text', 'entities']) && typeof value.target === 'string' && uuid.test(value.target) && text(value.text, 8000) && (value.entities === undefined || (validEntities(value.entities, (value.text as string).length) && value.entities.length > 0));
    case 'delete': return only(value, ['type', 'target']) && typeof value.target === 'string' && uuid.test(value.target);
    case 'react': return only(value, ['type', 'target', 'emoji']) && typeof value.target === 'string' && uuid.test(value.target) && (value.emoji === null || (REACTIONS as readonly unknown[]).includes(value.emoji));
    case 'pin': return only(value, ['type', 'target']) && (value.target === null || (typeof value.target === 'string' && uuid.test(value.target)));
    case 'vote': return only(value, ['type', 'target', 'options']) && typeof value.target === 'string' && uuid.test(value.target) && Array.isArray(value.options) && value.options.length <= POLL_LIMITS.maxOptions && value.options.every(index => Number.isInteger(index) && index >= 0 && index < POLL_LIMITS.maxOptions) && new Set(value.options).size === value.options.length;
    case 'call': return only(value, ['type', 'call', 'step', 'video', 'sdp', 'reason', 'duration', 'caller']) && typeof value.call === 'string' && uuid.test(value.call)
      && (value.step === 'offer' || value.step === 'answer' || value.step === 'end')
      && (value.video === undefined || typeof value.video === 'boolean')
      && (value.sdp === undefined || (typeof value.sdp === 'string' && value.sdp.length <= 60000 && value.sdp.startsWith('v=0')))
      && (value.step === 'end' ? value.sdp === undefined : typeof value.sdp === 'string')
      && (value.reason === undefined || ['hangup', 'declined', 'busy', 'missed', 'failed'].includes(value.reason as string))
      // The outcome fields belong to the `end` only: a week is the longest call anyone will believe.
      && (value.duration === undefined || (value.step === 'end' && Number.isInteger(value.duration) && (value.duration as number) >= 0 && (value.duration as number) <= 7 * 86400))
      && (value.caller === undefined || (value.step === 'end' && typeof value.caller === 'boolean'));
    case 'settings': return only(value, ['type', 'ttl', 'noCopy']) && (AUTO_DELETE as readonly unknown[]).includes(value.ttl) && typeof value.noCopy === 'boolean';
    case 'clear': return only(value, ['type']);
    default: return false;
  }
}

export function validMeta(value: unknown): value is MessageMeta {
  if (value === undefined) return true;
  if (!record(value) || !only(value, ['reply', 'forward', 'action', 'album', 'poll', 'entities', 'story', 'silent']) || !Object.keys(value).length) return false;
  if (value.silent !== undefined && value.silent !== true) return false;
  if (value.story !== undefined) {
    const story = value.story;
    // A story reference is a quote of its own: never together with a reply quote.
    if (!record(story) || !only(story, ['id', 'ownerId']) || typeof story.id !== 'string' || !uuid.test(story.id) || typeof story.ownerId !== 'string' || !uuid.test(story.ownerId) || value.reply !== undefined) return false;
  }
  if (value.entities !== undefined && (!validEntities(value.entities) || !value.entities.length)) return false;
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
    case 'pin': return action.target ? `Закреплено сообщение${quote}` : 'Сообщение откреплено';
    case 'vote': return action.options.length ? `🗳 Голос в опросе${quote}` : `Голос отменён${quote}`;
    case 'settings': return action.ttl ? `⏱ Автоудаление: ${autoDeleteLabel(action.ttl)}` : action.noCopy ? '🚫 Копирование запрещено' : '⏱ Автоудаление выключено';
    case 'clear': return '🧹 История очищена';
    case 'call': return action.step === 'offer' ? (action.video ? '📹 Видеозвонок' : '📞 Звонок') : action.step === 'answer' ? '📞 Звонок принят' : callPreview(action);
  }
}

export const messageKey = (message: Pick<Message, 'senderId' | 'clientId'>) => `${message.senderId}:${message.clientId}`;

/** Telegram: a message can be edited for 48 hours after it was sent. */
export const EDIT_WINDOW_MS = 48 * 3600_000;
/** Clocks of two phones differ: an edit up to this much past the window is still taken. */
export const EDIT_CLOCK_SKEW_MS = 10 * 60_000;
/** Whether an edit sent at `editAt` applies to a message sent at `sentAt` (both from the author's clock). Unknown times are not held against it. */
export const editInTime = (sentAt: string, editAt: string) => { const sent = Date.parse(sentAt), edit = Date.parse(editAt); return !Number.isFinite(sent) || !Number.isFinite(edit) || edit - sent <= EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS; };
export const EDIT_WINDOW_CLOSED = 'Изменить сообщение можно в течение 48 часов после отправки.';
export const editWindowOpen = (createdAt: string, now = Date.now()) => { const sent = Date.parse(createdAt); return Number.isFinite(sent) && now - sent < EDIT_WINDOW_MS; };

/** Telegram does not show these in the chat list: a reaction, an unpin, a poll vote, an edit or a
 *  deletion changes another message — the list keeps showing the last real message instead. */
export function isQuietAction(message: Pick<Message, 'meta'>): boolean {
  const action = message.meta?.action;
  if (!action) return false;
  return action.type === 'react' || action.type === 'vote' || action.type === 'edit' || action.type === 'delete' || (action.type === 'pin' && !action.target);
}

/** The message the chat list should show: the newest one that is not a quiet action and was not
 *  deleted, with its latest edit applied. Null when the given messages hold none. */
export function listPreviewMessage<T extends Message>(list: readonly T[]): T | null {
  const deleted = new Set<string>(), edits = new Map<string, (Edit & { at: string })[]>();
  const sorted = [...list].sort((a, b) => b.id - a.id);
  for (const message of sorted) {
    const action = message.meta?.action;
    // An action names its target by clientId; only the author edits or deletes, so the target is the
    // action sender's own message (senderId:clientId — the same key as the message below).
    if (message.cryptoState !== undefined && message.cryptoState !== 'decrypted') continue;
    if (action?.type === 'delete') deleted.add(messageKey({ senderId: message.senderId, clientId: action.target }));
    if (action?.type === 'edit') { const key = messageKey({ senderId: message.senderId, clientId: action.target }); edits.set(key, [...(edits.get(key) ?? []), { text: action.text, entities: action.entities, at: message.createdAt }]); }
  }
  for (const message of sorted) {
    if (isQuietAction(message) || isCallSignal(message) || deleted.has(messageKey(message))) continue;
    // The newest edit made within the window (a later one, past 48 h, is ignored).
    const edited = edits.get(messageKey(message))?.find(edit => editInTime(message.createdAt, edit.at));
    const shown = edited !== undefined && !message.meta?.action ? withEdit(message, edited) : message;
    // The list must not give a spoiler away.
    const masked = chatListText(shown);
    return masked === shown.text ? shown : { ...shown, text: masked };
  }
  return null;
}
export const isAction = (message: Pick<Message, 'meta'>) => !!message.meta?.action;
/** A call offer or answer only carries the SDP: invisible in the chat, so not the list line either (the `end` is). */
export const isCallSignal = (message: Pick<Message, 'meta'>) => message.meta?.action?.type === 'call' && message.meta.action.step !== 'end';
/** The chat list looks past this message for the line to show (an action on another message, a call's signalling). */
export const skippedInList = (message: Pick<Message, 'meta'>) => isQuietAction(message) || isCallSignal(message);

/** The encrypted `end` of a call (F9): the one trace a call leaves in the chat and in Люди › Звонки. */
export type CallEndAction = Extract<MessageAction, { type: 'call' }> & { step: 'end' };
/** A readable `end`: decrypted here, or a server `lastMessage` whose meta arrived without a crypto state. */
export const isCallEnd = (message: Pick<Message, 'meta' | 'cryptoState'>): message is Message & { meta: { action: CallEndAction } } => {
  const action = message.meta?.action;
  return !!action && action.type === 'call' && action.step === 'end' && (message.cryptoState === undefined || message.cryptoState === 'decrypted');
};
/** The one `end` to show per call (both phones may have sent one): the one that knows the duration, else the earliest. */
export function dedupeCallEnds<T extends Message>(messages: readonly T[]): T[] {
  const byCall = new Map<string, T>();
  for (const message of messages) {
    if (!isCallEnd(message)) continue;
    const action = message.meta.action; const kept = byCall.get(action.call);
    if (!kept) { byCall.set(action.call, message); continue; }
    const keptAction = kept.meta!.action as CallEndAction;
    const better = (action.duration !== undefined && keptAction.duration === undefined) || (action.duration !== undefined) === (keptAction.duration !== undefined) && message.id < kept.id;
    if (better) byCall.set(action.call, message);
  }
  return [...byCall.values()];
}

type Edit = { text: string; entities?: Entity[] };
/** The message with an edit applied: new text, and the edit's formatting replaces the old one. */
function withEdit<T extends Message>(message: T, edit: Edit): T {
  const meta = { ...message.meta };
  delete meta.entities;
  if (edit.entities?.length) meta.entities = edit.entities;
  return { ...message, text: edit.text, ...(Object.keys(meta).length ? { meta } : { meta: undefined }) };
}
/** Chat-list line for a message: plain text with spoilers hidden (▒), formatting dropped. */
export const chatListText = (message: Pick<Message, 'text' | 'meta'>) => message.meta?.action?.type === 'call' && message.meta.action.step === 'end' ? callPreview(message.meta.action) : maskSpoilers(message.text, message.meta?.entities);

/**
 * Chat-list line (and fallback text) for a finished call. The same text is stored by the sender and
 * shown on both phones, so it names no direction: «📞 Пропущенный звонок» is what the person who
 * missed it needs to see (a missed call is the one call row that counts as unread, see chatUnread),
 * an answered call reads «📞 Звонок · 3:12». The chat itself shows the direction (callServiceText).
 */
export function callPreview(action: Extract<MessageAction, { type: 'call' }>): string {
  const icon = action.video ? '📹' : '📞', noun = action.video ? 'Видеозвонок' : 'Звонок';
  switch (action.reason) {
    case 'missed': return `${icon} Пропущенный ${action.video ? 'видеозвонок' : 'звонок'}`;
    case 'declined': case 'busy': return `${icon} Отклонённый ${action.video ? 'видеозвонок' : 'звонок'}`;
    case 'failed': return `${icon} ${noun} не удался`;
    default: return action.duration === undefined ? `${icon} ${noun}` : `${icon} ${noun} · ${formatCallDuration(action.duration)}`;
  }
}

export type ReactionSummary = { emoji: Reaction; count: number; mine: boolean };
export type PollResults = { counts: number[]; mine: number[]; voters: number };
export type ViewMessage = Message & { edited: boolean; reactions: ReactionSummary[]; poll?: PollResults };
export type ChatView = { messages: ViewMessage[]; pinned: ViewMessage | null; byClientId: Map<string, ViewMessage>; rules: ChatRules; nextExpiry: number | null };

/**
 * Applies encrypted actions to the decrypted history, oldest first.
 * Only the author may edit or delete a message; each participant has at most
 * one reaction per message (the latest wins); the latest pin from either side wins.
 */
export function foldChat(messages: Message[], userId: string, hiddenForMe: ReadonlySet<string> = new Set(), now = Date.now()): ChatView {
  const ordered = [...messages].sort((a, b) => a.id - b.id);
  const content = new Map<string, Message>();
  const authorOf = new Map<string, string>();
  for (const message of ordered) if (!isAction(message)) { content.set(message.clientId, message); authorOf.set(message.clientId, message.senderId); }
  // A finished call is a service row in the chat («Исходящий звонок · 3:12»), one per call even when
  // both phones sent an `end`; offers and answers stay invisible (they only carry the SDP).
  for (const message of dedupeCallEnds(ordered)) { content.set(message.clientId, message); authorOf.set(message.clientId, message.senderId); }
  const edits = new Map<string, Edit>(), deleted = new Set<string>(), reactions = new Map<string, Map<string, Reaction>>();
  const votes = new Map<string, Map<string, number[]>>();
  let pin: string | null = null;
  // Rules in force at each moment: a message keeps the auto-delete that applied when it was sent.
  let rules: ChatRules = { ttl: 0, noCopy: false }; let clearedBefore = 0;
  const ttlOf = new Map<string, number>();
  for (const message of ordered) {
    const action = message.meta?.action;
    if (!action) { ttlOf.set(message.clientId, rules.ttl); continue; }
    if (message.cryptoState !== 'decrypted') continue;
    if (action.type === 'settings') { rules = { ttl: action.ttl, noCopy: action.noCopy }; continue; }
    if (action.type === 'clear') { clearedBefore = message.id; continue; }
  }
  for (const message of ordered) {
    const action = message.meta?.action;
    if (!action || message.cryptoState !== 'decrypted') continue;
    if (action.type === 'call' || action.type === 'settings' || action.type === 'clear') continue;
    if (action.type === 'pin') { pin = action.target; continue; }
    const author = authorOf.get(action.target);
    if (action.type === 'edit' || action.type === 'delete') {
      if (author !== message.senderId) continue; // only the author; unknown targets are ignored
      if (action.type === 'edit') { if (editInTime(content.get(action.target)!.createdAt, message.createdAt)) edits.set(action.target, { text: action.text, entities: action.entities }); }
      else deleted.add(action.target);
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
  let nextExpiry: number | null = null;
  for (const message of content.values()) {
    if (deleted.has(message.clientId) || hiddenForMe.has(messageKey(message))) continue;
    if (message.id > 0 && message.id < clearedBefore) continue;
    const ttl = ttlOf.get(message.clientId) || 0;
    if (ttl) {
      const expires = Date.parse(message.createdAt) + ttl * 1000;
      if (expires <= now) continue;
      if (nextExpiry === null || expires < nextExpiry) nextExpiry = expires;
    }
    const perUser = reactions.get(message.clientId);
    const summary = new Map<Reaction, ReactionSummary>();
    if (perUser) for (const [reactor, emoji] of perUser) {
      const item = summary.get(emoji) ?? { emoji, count: 0, mine: false };
      item.count++; if (reactor === userId) item.mine = true; summary.set(emoji, item);
    }
    const edit = edits.get(message.clientId);
    const item: ViewMessage = { ...(edit !== undefined ? withEdit(message, edit) : message), edited: edit !== undefined, reactions: [...summary.values()].sort((a, b) => REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji)) };
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
  return { messages: view, pinned: pin ? byClientId.get(pin) ?? null : null, byClientId, rules, nextExpiry };
}

/** Plain-text one-line quote for a reply. */
export function replyPreview(message: Pick<Message, 'text' | 'attachment' | 'meta'>): string {
  if (message.meta?.poll) return `📊 ${message.meta.poll.question}`.slice(0, 200);
  // Formatting is dropped in a quote; a spoiler stays hidden (the preview is plain text).
  const body = maskSpoilers(message.text, message.meta?.entities).trim().replace(/\s+/g, ' ');
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

/** Telegram's chat-list line for a pin: «Вы закрепили «…»» / «Имя закрепил(а) «…»» (no emoji). */
export function pinPreview(text: string, mine: boolean, name: string): string {
  const quote = /«[^]*»\s*$/.exec(text.trim())?.[0] ?? '';
  return `${mine ? 'Вы закрепили' : `${name} закрепил(а)`}${quote ? ` ${quote}` : ' сообщение'}`;
}
