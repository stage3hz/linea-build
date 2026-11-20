// Which posts («записи») from the stories strip this account has already opened on this device. The server
// keeps a "seen" state for stories only (story_views), so for posts it lives here, per account, in
// AsyncStorage: a post counts as unseen (bright ring, ahead in the strip) until it is opened once in this
// installation. Pure logic first (covered by test/seen-posts.test.mjs), then the small shared store.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/** A post stays in the strip for 48 hours, so a few hundred ids are far more than can be live at once. */
export const SEEN_POSTS_LIMIT = 500;

/** The stored list, validated: strings only, no duplicates, at most SEEN_POSTS_LIMIT (newest kept). */
export function parseSeenPosts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))];
    return ids.slice(-SEEN_POSTS_LIMIT);
  } catch { return []; }
}

/** The list with `ids` added (the oldest dropped past the limit); the same array when all were there already. */
export function withSeenPosts(list: readonly string[], ids: readonly string[]): readonly string[] {
  const fresh = [...new Set(ids)].filter(id => id && !list.includes(id));
  return fresh.length ? [...list, ...fresh].slice(-SEEN_POSTS_LIMIT) : list;
}

type StripEntry = { stories: readonly unknown[]; unseen: number; posts?: readonly { id: string }[]; latest?: string };
/** Something new to look at: an unwatched story, or (for a person shown for a post) a post not opened here yet. */
export function hasUnseen(item: StripEntry, seen: ReadonlySet<string>): boolean {
  return item.stories.length ? item.unseen > 0 : (item.posts ?? []).some(post => !seen.has(post.id));
}
/** The strip's order: people with something unseen, then the rest; inside each group the newest story or post first. */
export function stripOrder<T extends StripEntry>(items: readonly T[], seen: ReadonlySet<string>): T[] {
  return [...items].sort((a, b) => Number(hasUnseen(b, seen)) - Number(hasUnseen(a, seen)) || (a.latest && b.latest ? b.latest.localeCompare(a.latest) : 0));
}

// ─── Store ──────────────────────────────────────────────────────────────────────────────────────

const key = (userId: string) => `linea.seen-posts.v1:${userId}`;
const EMPTY: ReadonlySet<string> = new Set();
type Entry = { list: readonly string[]; set: ReadonlySet<string>; listeners: Set<() => void> };
const entries = new Map<string, Entry>();

function entry(userId: string): Entry {
  let item = entries.get(userId);
  if (!item) {
    const created: Entry = { list: [], set: EMPTY, listeners: new Set() };
    entries.set(userId, created);
    item = created;
    AsyncStorage.getItem(key(userId)).then(raw => {
      // Posts opened before the stored list arrived are kept: the two lists are merged.
      const list = withSeenPosts(parseSeenPosts(raw), created.list);
      if (list.length !== created.list.length) { created.list = list; created.set = new Set(list); created.listeners.forEach(listener => listener()); }
    }).catch(() => {});
  }
  return item;
}

/** The posts this account opened from the strip on this device (a stable Set, replaced on every change). */
export function useSeenPosts(userId: string): ReadonlySet<string> {
  const item = entry(userId);
  return useSyncExternalStore(listener => { item.listeners.add(listener); return () => { item.listeners.delete(listener); }; }, () => item.set, () => EMPTY);
}
/** Remembers that these posts were opened. */
export function markPostsSeen(userId: string, ids: readonly string[]) {
  const item = entry(userId);
  const next = withSeenPosts(item.list, ids);
  if (next === item.list) return;
  item.list = next; item.set = new Set(next);
  item.listeners.forEach(listener => listener());
  void AsyncStorage.setItem(key(userId), JSON.stringify(next)).catch(() => {});
}
