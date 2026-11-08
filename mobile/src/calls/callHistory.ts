// История звонков (F9): a pure model over the decrypted message cache, no React Native imports.
// A call leaves exactly one trace in the chat: the encrypted `end` action (meta.action.call) that
// whoever finished it sent. It carries the outcome (`reason`), the length (`duration`, seconds),
// whether it was a video call and whether its sender placed the call (`caller`), so both phones
// render the same service row and the same entry in Люди › Звонки — without asking the server.
import type { Chat, Message } from '../types';
import { dedupeCallEnds, isCallEnd, type CallEndAction } from '../messageMeta';
import { formatCallDuration } from './callModel';

export { dedupeCallEnds, isCallEnd, type CallEndAction };
/** The row as Telegram names it, from this account's point of view. */
export type CallKind = 'outgoing' | 'incoming' | 'missed' | 'cancelled' | 'declined' | 'busy' | 'failed';
export type CallRecord = {
  /** `${chatId}:${callId}` — one entry per call, even when both phones sent an `end`. */
  key: string; callId: string; messageId: number; clientId: string; chat: Chat; at: string;
  kind: CallKind; video: boolean; duration?: number;
  /** A missed call of the peer the chat has not been read past yet: the red badge. */
  unseen: boolean;
};
export type CallDayGroup = { day: string; label: string; calls: CallHistoryRow[] };
/** Consecutive calls of one kind with the same person on one day fold into «Имя (3)», as in Telegram. */
export type CallHistoryRow = CallRecord & { count: number };

/** Did the sender of this `end` place the call? Older clients send no `caller`; the reason tells then. */
export function senderPlacedCall(action: Pick<CallEndAction, 'caller' | 'reason'>): boolean {
  if (typeof action.caller === 'boolean') return action.caller;
  // «declined» and «busy» are the callee's answers; «missed» is the caller giving up; a hang-up or failure may be either, the caller is the better guess.
  return action.reason !== 'declined' && action.reason !== 'busy';
}

/** The kind of row this account sees for the call: who called whom, and how it ended. */
export function classifyCall(action: Pick<CallEndAction, 'caller' | 'reason' | 'duration'>, senderId: string, userId: string): CallKind {
  const outgoing = senderPlacedCall(action) ? senderId === userId : senderId !== userId;
  switch (action.reason) {
    case 'missed': return outgoing ? 'cancelled' : 'missed';
    case 'declined': return 'declined';
    case 'busy': return outgoing ? 'busy' : 'missed';
    case 'failed': return 'failed';
    default: return outgoing ? 'outgoing' : 'incoming';
  }
}

export function callLabel(kind: CallKind, video = false): string {
  switch (kind) {
    case 'outgoing': return video ? 'Исходящий видеозвонок' : 'Исходящий звонок';
    case 'incoming': return video ? 'Входящий видеозвонок' : 'Входящий звонок';
    case 'missed': return video ? 'Пропущенный видеозвонок' : 'Пропущенный звонок';
    case 'cancelled': return video ? 'Отменённый видеозвонок' : 'Отменённый звонок';
    case 'declined': return video ? 'Отклонённый видеозвонок' : 'Отклонённый звонок';
    case 'busy': return 'Собеседник занят';
    case 'failed': return video ? 'Видеозвонок не удался' : 'Звонок не удался';
  }
}

/** Was the call answered (so a duration makes sense)? */
export const callAnswered = (kind: CallKind) => kind === 'outgoing' || kind === 'incoming';

/** «Исходящий звонок · 3:12», «Пропущенный звонок» — the centred service row in the chat. */
export function callServiceText(action: Pick<CallEndAction, 'caller' | 'reason' | 'duration' | 'video'>, senderId: string, userId: string): string {
  const kind = classifyCall(action, senderId, userId);
  const label = callLabel(kind, !!action.video);
  return callAnswered(kind) && action.duration !== undefined ? `${label} · ${formatCallDuration(action.duration)}` : label;
}

/**
 * The chat-list line for a chat whose last message is a finished call: with the direction, as the chat
 * shows it («Исходящий звонок · 3:12», «Пропущенный звонок»); null for anything else. The stored
 * fallback text (callPreview) names no direction, since the same text is read on both phones.
 */
export function callListText(message: Pick<Message, 'meta' | 'senderId' | 'cryptoState'>, userId: string): string | null {
  return isCallEnd(message) ? callServiceText(message.meta.action, message.senderId, userId) : null;
}

/**
 * Every call this device knows about: the loaded pages of each chat plus the chat's last message
 * (the list knows it even for a chat never opened), newest first.
 */
export function buildCallHistory(chats: readonly Chat[], messages: Readonly<Record<string, readonly Message[] | undefined>>, userId: string): CallRecord[] {
  const out: CallRecord[] = [];
  for (const chat of chats) {
    const loaded = messages[chat.id] ?? [];
    const last = chat.lastMessage;
    const pool = last && isCallEnd(last) && !loaded.some(m => m.clientId === last.clientId) ? [...loaded, last] : loaded;
    for (const message of dedupeCallEnds(pool)) {
      const action = message.meta?.action;
      if (!action || action.type !== 'call') continue;
      const kind = classifyCall(action, message.senderId, userId);
      out.push({
        key: `${chat.id}:${action.call}`, callId: action.call, messageId: message.id, clientId: message.clientId, chat, at: message.createdAt,
        kind, video: !!action.video, ...(callAnswered(kind) && action.duration !== undefined ? { duration: action.duration } : {}),
        unseen: kind === 'missed' && message.senderId !== userId && message.id > chat.lastReadMessageId,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.messageId - a.messageId);
}

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** «Сегодня», «Вчера», «3 ноября», «3 ноября 2025 г.» (another year). */
export function callDayLabel(at: string, nowMs = Date.now()): string {
  const date = new Date(at), now = new Date(nowMs);
  if (dayKey(date) === dayKey(now)) return 'Сегодня';
  const yesterday = new Date(nowMs); yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Вчера';
  return date.toLocaleDateString('ru-RU', date.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Newest first, grouped by local day; neighbours of one kind with one person on one day become a single «(n)» row. */
export function groupCallsByDay(records: readonly CallRecord[], nowMs = Date.now()): CallDayGroup[] {
  const groups: CallDayGroup[] = [];
  const sorted = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.messageId - a.messageId);
  for (const record of sorted) {
    const day = dayKey(new Date(record.at));
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) { group = { day, label: callDayLabel(record.at, nowMs), calls: [] }; groups.push(group); }
    const previous = group.calls[group.calls.length - 1];
    if (previous && previous.chat.id === record.chat.id && previous.kind === record.kind && previous.video === record.video) { previous.count++; previous.unseen = previous.unseen || record.unseen; continue; }
    group.calls.push({ ...record, count: 1 });
  }
  return groups;
}

/** Missed calls not read yet: the badge on «Звонки». */
export const unseenMissedCount = (records: readonly CallRecord[]) => records.filter(record => record.unseen).length;
