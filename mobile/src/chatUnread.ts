import type { Chat, Message } from './types';

/**
 * A call the peer started and gave up on («Нет ответа»): the only call row Telegram counts as
 * unread. An offer we answered, a decline or a hang-up by either side are not news.
 */
const missedCall = (message: Message, userId: string) => { const action = message.meta?.action; return action?.type === 'call' && action.step === 'end' && action.reason === 'missed' && message.senderId !== userId; };
/** Reactions, edits, votes, pins and the like change another message and never count as unread (Telegram); a missed call does. */
export const countsAsUnread = (message: Message, userId: string) => !message.mesh && message.senderId !== userId && (!message.meta?.action || missedCall(message, userId));

/** Unread messages among `messages` after the read watermark, by the client's rule. */
export const countUnread = (messages: readonly Message[], lastReadId: number, userId: string) => messages.filter(m => m.id > lastReadId && countsAsUnread(m, userId)).length;

/**
 * The server counts every row of the peer after last_read, actions included (it cannot see inside
 * the ciphertext). When the loaded messages cover everything after the watermark, the client's own
 * count wins, so a reaction does not light the chat up after the next list refresh.
 */
export function coversUnread(chat: Pick<Chat, 'lastReadMessageId' | 'lastMessage'>, loaded: readonly Message[] | undefined, hasMore?: boolean): boolean {
  const real = loaded?.filter(m => !m.mesh);
  if (!real?.length) return false;
  return (real[0].id <= chat.lastReadMessageId || hasMore === false) && (!chat.lastMessage || real[real.length - 1].id >= chat.lastMessage.id);
}
export function reconcileUnread(chat: Chat, loaded: readonly Message[] | undefined, userId: string, hasMore?: boolean): Chat {
  if (!chat.unreadCount || !coversUnread(chat, loaded, hasMore)) return chat;
  const unreadCount = countUnread(loaded!.filter(m => !m.mesh), chat.lastReadMessageId, userId);
  return unreadCount === chat.unreadCount ? chat : { ...chat, unreadCount };
}

/**
 * «Прочитать» from the list must reach the newest server message, not the one the list shows:
 * the preview hides reactions and edits, and the server counts them, so reading up to the shown
 * message brought the badge back on the next refresh.
 */
export const readUpTo = (raw: Pick<Chat, 'lastMessage'> | undefined, shownId: number) => Math.max(shownId, raw?.lastMessage?.id || 0);

/**
 * A message still waiting for keys: an envelope for this device not opened yet (inbox sync
 * behind), or a sender device not confirmed yet. A message with no envelope for this device (sent
 * before this device signed in), a damaged one («failed») and an invalid one never change, so
 * they must not keep the chat unread forever. The real pages and the socket are lean (no
 * `encrypted`), so a no-key message there is judged by `inboxSynced`: once the inbox sync of this
 * chat has gone through and the message is still without a key, no key is coming.
 */
export function awaitingDecryption(message: Message, userId: string, deviceId: string | null, inboxSynced = false): boolean {
  if (message.cryptoState === 'unverified') return true;
  if (message.cryptoState !== 'no-key') return false;
  if (!message.encrypted) return !inboxSynced;
  return message.encrypted.envelopes.some(item => item.userId === userId && item.deviceId === deviceId);
}

/** The id to mark as read after showing a page: everything before the first message still waiting for keys. */
export function readWatermark(page: readonly Message[], userId: string, deviceId: string | null, inboxSynced = false): number {
  let mark = 0;
  for (const message of page) { if (awaitingDecryption(message, userId, deviceId, inboxSynced)) break; mark = message.id; }
  return mark;
}
