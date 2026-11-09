// Telegram «Пометить как непрочитанное» (swipe right on a read chat, or the chat's long-press menu).
// The server has no such flag, so it lives on this device only, per account, in AsyncStorage (as the
// chat folders do). A marked chat shows an empty unread badge, sits in «Непрочитанные» and counts as
// one unread chat in the tab badge. The mark goes away when the chat is opened or marked read.
// Pure logic first (covered by test/marked-unread.test.mjs), then the small shared store.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/** Telegram keeps the mark on any number of dialogs; a cap keeps a damaged entry from growing without end. */
export const MARKED_LIMIT = 500;

type ChatLike = { id: string; unreadCount: number };

/** The stored list, validated: strings only, no duplicates, at most MARKED_LIMIT (newest kept). */
export function parseMarked(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))];
    return ids.slice(-MARKED_LIMIT);
  } catch { return []; }
}

/** The list with `chatId` marked (true) or unmarked (false); the same array when nothing changes. */
export function withMarked(list: readonly string[], chatId: string, on: boolean): readonly string[] {
  const has = list.includes(chatId);
  if (on === has || !chatId) return list;
  return on ? [...list, chatId].slice(-MARKED_LIMIT) : list.filter(id => id !== chatId);
}

/** Marks of chats that no longer exist (deleted, left) are dropped; the same array when all are known. */
export function pruneMarked(list: readonly string[], chatIds: Iterable<string>): readonly string[] {
  const known = new Set(chatIds);
  const next = list.filter(id => known.has(id));
  return next.length === list.length ? list : next;
}

/** The row, the swipe and «Непрочитанные» treat a chat as unread when it has unread messages or the mark. */
export function showsUnread(chat: ChatLike, marked: ReadonlySet<string>): boolean {
  return chat.unreadCount > 0 || marked.has(chat.id);
}

/**
 * What the marks add to the tab badge (which counts unread messages): one for each marked chat
 * without unread messages that the badge would count at all (`counted`: not archived, not muted),
 * as in Telegram, where a marked dialog adds 1 to the total.
 */
export function markedExtra(chats: readonly ChatLike[], marked: ReadonlySet<string>, counted: (chat: ChatLike) => boolean): number {
  if (!marked.size) return 0;
  let extra = 0;
  for (const chat of chats) if (chat.unreadCount <= 0 && marked.has(chat.id) && counted(chat)) extra++;
  return extra;
}

// ─── Store ──────────────────────────────────────────────────────────────────────────────────────

const key = (userId: string) => `linea.marked-unread.v1:${userId}`;
const EMPTY: ReadonlySet<string> = new Set();
type Entry = { list: readonly string[]; set: ReadonlySet<string>; listeners: Set<() => void>; touched: boolean };
const entries = new Map<string, Entry>();

function entry(userId: string): Entry {
  let item = entries.get(userId);
  if (!item) {
    const created: Entry = { list: [], set: EMPTY, listeners: new Set(), touched: false };
    entries.set(userId, created);
    item = created;
    AsyncStorage.getItem(key(userId)).then(raw => {
      // A mark made before the stored list arrived wins over it.
      if (created.touched) return;
      const list = parseMarked(raw);
      if (list.length) { created.list = list; created.set = new Set(list); created.listeners.forEach(listener => listener()); }
    }).catch(() => {});
  }
  return item;
}

function save(userId: string, next: readonly string[]) {
  const item = entry(userId);
  if (next === item.list) return;
  item.touched = true;
  item.list = next; item.set = new Set(next);
  item.listeners.forEach(listener => listener());
  void AsyncStorage.setItem(key(userId), JSON.stringify(next)).catch(() => {});
}

/** The chats this account marked unread on this device (a stable Set, replaced on every change). */
export function useMarkedUnread(userId: string): ReadonlySet<string> {
  const item = entry(userId);
  return useSyncExternalStore(listener => { item.listeners.add(listener); return () => { item.listeners.delete(listener); }; }, () => item.set, () => EMPTY);
}
export function getMarkedUnread(userId: string): ReadonlySet<string> { return entry(userId).set; }
export function setMarkedUnread(userId: string, chatId: string, on: boolean) { save(userId, withMarked(entry(userId).list, chatId, on)); }
/** Called with the full chat list: forgets marks of chats that are gone. */
export function pruneMarkedUnread(userId: string, chatIds: Iterable<string>) {
  const item = entry(userId);
  if (item.list.length) save(userId, pruneMarked(item.list, chatIds));
}

// The tab bars get the unread total from App (src/unreadBadge.ts); the chat list publishes what the marks add to it.
let extra = 0;
const extraListeners = new Set<() => void>();
export function setMarkedExtra(next: number) { if (next !== extra) { extra = next; extraListeners.forEach(listener => listener()); } }
export function useMarkedExtra(): number {
  return useSyncExternalStore(listener => { extraListeners.add(listener); return () => { extraListeners.delete(listener); }; }, () => extra, () => 0);
}
