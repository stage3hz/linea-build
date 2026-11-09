import type { Chat, Message } from './types';

/**
 * Chat list like Telegram: the last message of every chat reads as text («Привет», «🖼 Фотография»,
 * «🎤 Голосовое сообщение», …) as soon as it has arrived, not «Зашифрованное сообщение. Открой чат…»
 * until the chat is opened. The server only has ciphertext, so this device opens its envelopes in the
 * background (CryptoService.syncChat: each message once, in order, cached in the vault) for the chats
 * whose list line is still closed — at start, on resume and when the socket comes back. Bounded:
 * at most CATCH_UP_CHATS chats per pass, unread and newest first, CATCH_UP_PAGES inbox pages each.
 */
export const CATCH_UP_CHATS = 20;
export const CATCH_UP_PAGES = 5;
/** What a list line says when the inbox of the chat was read through and the message still has no key here. */
export const NOT_FOR_DEVICE = 'Это сообщение недоступно на данном устройстве.';

/** A list line still closed: this device holds no decrypted copy of the message (yet). */
export const awaitsInbox = (message: Message | null | undefined): message is Message => !!message && message.cryptoState === 'no-key' && !message.mesh;

/**
 * The chats whose last message should be opened now: closed line, not already tried for that very
 * message (`skip`). Unread chats first, then the newest; at most `limit`.
 */
export function catchUpTargets(chats: readonly Chat[], skip: (chatId: string, messageId: number) => boolean, limit = CATCH_UP_CHATS): string[] {
  return chats
    .filter(chat => awaitsInbox(chat.lastMessage) && !skip(chat.id, chat.lastMessage!.id))
    .sort((a, b) => Number(b.unreadCount > 0) - Number(a.unreadCount > 0) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(chat => chat.id);
}

/**
 * The inbox of the chat went through and the message is still closed: it was sent before this device
 * signed in (no envelope for it), so no key is coming. Say so instead of «Открой чат для расшифровки».
 */
export function settled(message: Message): Message {
  return awaitsInbox(message) && message.text !== NOT_FOR_DEVICE ? { ...message, text: NOT_FOR_DEVICE, attachment: null } : message;
}

/**
 * A fresh server list (lean, re-read from the vault) never replaces a line this device has already
 * opened with a closed placeholder for the same message: a list read that raced a socket message
 * (the decrypt was still running) would otherwise put «Зашифровано» back.
 */
export function keepOpened(next: readonly Chat[], previous: readonly Chat[]): Chat[] {
  const before = new Map(previous.map(chat => [chat.id, chat.lastMessage] as const));
  return next.map(chat => {
    const last = chat.lastMessage, old = before.get(chat.id);
    if (!awaitsInbox(last) || !old || old.id !== last.id || old.cryptoState !== 'decrypted') return chat;
    return { ...chat, lastMessage: old };
  });
}

/** A chat whose last message was tried and did not open is tried again for that message at most once a minute. */
export const RETRY_AFTER_MS = 60_000;
export type Tried = { id: number; at: number };
export const recentlyTried = (entry: Tried | undefined, messageId: number, now: number) => !!entry && entry.id === messageId && now - entry.at < RETRY_AFTER_MS;

/** A chat with more than CATCH_UP_PAGES pages waiting goes on from the cursor: a few more passes, for at most CATCH_UP_DEEP chats per round. */
export const CATCH_UP_EXTRA_PASSES = 4;
export const CATCH_UP_DEEP = 2;
export type SyncOutcome = 'synced' | 'partial' | 'failed' | 'network';
const isNetworkError = (error: unknown) => error instanceof Error && error.name === 'NetworkError';
const isPartial = (error: unknown) => error instanceof Error && error.name === 'PartialSync';
/**
 * One chat's background sync: `sync` is CryptoService.syncChat bound to the chat with a page cap;
 * every pass resumes from the vault cursor, so nothing is decrypted twice. `deep`: may use the extra passes.
 */
export async function syncForList(sync: () => Promise<void>, deep: boolean, extra = CATCH_UP_EXTRA_PASSES): Promise<SyncOutcome> {
  for (let pass = 0; ; pass++) {
    try { await sync(); return 'synced'; }
    catch (error) {
      if (isNetworkError(error)) return 'network';
      if (!isPartial(error)) return 'failed';
      if (!deep || pass >= extra) return 'partial';
    }
  }
}

/**
 * The list line after a background sync. Only a full sync AND a preview that ran without an exception
 * are this device's verdict («недоступно на данном устройстве», never tried again); a vault/Signal
 * exception's placeholder is shown as it is and the chat is tried again later.
 */
export function afterSync(line: Message, outcome: SyncOutcome, opened: boolean): { line: Message; caughtUp: boolean } {
  const caughtUp = outcome === 'synced' && opened;
  return { line: caughtUp ? settled(line) : line, caughtUp };
}
