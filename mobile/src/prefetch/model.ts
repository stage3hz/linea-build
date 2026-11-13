// Фоновое обновление (Android): while the app is closed, the system lets it run for a few seconds now and then.
// In that time it downloads the ENCRYPTED messages waiting for this device and keeps them as they came; nothing is
// decrypted and no key is touched (decrypting in the background, beside an open app, could move the conversation's
// keys twice and break it). When the app is opened, the same request the app would send to the server is answered
// from that copy first, so the chats come up to date at once instead of after several round trips.
//
// This file is the rules, without any platform code (store.ts keeps the copies, task.ts is the background run).
//  - The «plan»: this device's id and, per chat, the id of the last message it has decrypted (its cursor). Written
//    by the open app; the background run only reads it.
//  - A kept page answers a request only for exactly the same device, chat and cursor, and only while fresh —
//    anything else goes to the server as before.

export type InboxPage = { messages: { id: number; chatId?: string }[]; nextCursor: number; hasMore: boolean };
export type PrefetchPlan = { deviceId: string; cursors: Record<string, number> };
export type KeptPage = { deviceId: string; chatId: string; after: number; at: number; result: InboxPage };

/** How many chats one background run looks at, and how long a kept page may wait to be used. */
export const PREFETCH_CHATS = 6;
export const PREFETCH_FRESH_MS = 12 * 60 * 60_000;
/** A background run stops starting new requests after this long (the system gives it about half a minute). */
export const PREFETCH_BUDGET_MS = 18_000;
const CHAT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function parsePlan(raw: string | null | undefined): PrefetchPlan | null {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.deviceId !== 'string' || !value.deviceId || typeof value.cursors !== 'object' || !value.cursors) return null;
    const cursors: Record<string, number> = {};
    for (const [chatId, cursor] of Object.entries(value.cursors)) if (CHAT_ID.test(chatId) && Number.isSafeInteger(cursor) && (cursor as number) >= 0) cursors[chatId] = cursor as number;
    return { deviceId: value.deviceId, cursors };
  } catch { return null; }
}

/** The plan after this device read chat `chatId` up to `cursor`. A cursor never goes back; another device id (a new
 *  account or a re-created device) starts the plan anew. */
export function planWith(plan: PrefetchPlan | null, deviceId: string, chatId: string, cursor: number): PrefetchPlan {
  const base = plan && plan.deviceId === deviceId ? plan : { deviceId, cursors: {} };
  if (!CHAT_ID.test(chatId) || !Number.isSafeInteger(cursor) || cursor < 0 || (base.cursors[chatId] ?? -1) >= cursor) return base;
  return { deviceId, cursors: { ...base.cursors, [chatId]: cursor } };
}

/** The chats worth a request in this run: unread, known to the plan, with something newer than the cursor — the
 *  most recently active first. */
export function prefetchTargets(chats: readonly { id: string; unreadCount?: number; lastMessage?: { id?: number } | null; updatedAt?: string }[], plan: PrefetchPlan, limit = PREFETCH_CHATS): { chatId: string; after: number }[] {
  return chats
    .filter(chat => (chat.unreadCount || 0) > 0 && plan.cursors[chat.id] !== undefined && (chat.lastMessage?.id ?? 0) > plan.cursors[chat.id])
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
    .map(chat => ({ chatId: chat.id, after: plan.cursors[chat.id] }));
}

/** A page as the server sends it: messages of this chat in rising order after `after`. Anything else is not kept. */
export function validPage(result: unknown, chatId: string, after: number): result is InboxPage {
  const page = result as InboxPage | null;
  if (!page || !Array.isArray(page.messages) || typeof page.hasMore !== 'boolean' || !Number.isSafeInteger(page.nextCursor)) return false;
  let last = after;
  for (const message of page.messages) {
    if (!message || !Number.isSafeInteger(message.id) || message.id <= last || (message.chatId !== undefined && message.chatId !== chatId)) return false;
    last = message.id;
  }
  return true;
}

export function parseKept(raw: string | null | undefined): KeptPage | null {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.deviceId !== 'string' || typeof value.chatId !== 'string' || !Number.isSafeInteger(value.after) || !Number.isFinite(value.at)) return null;
    return validPage(value.result, value.chatId, value.after) ? value as KeptPage : null;
  } catch { return null; }
}

/** Whether a kept page answers the request the app is about to make. */
export function keptAnswers(kept: KeptPage | null, deviceId: string, chatId: string, after: number, now: number): boolean {
  return !!kept && kept.deviceId === deviceId && kept.chatId === chatId && kept.after === after && kept.result.messages.length > 0 && now - kept.at >= 0 && now - kept.at < PREFETCH_FRESH_MS;
}

/** The cursor a page leaves the device at. */
export const cursorAfter = (page: InboxPage, after: number): number => (page.messages.length ? page.messages[page.messages.length - 1].id : after);
