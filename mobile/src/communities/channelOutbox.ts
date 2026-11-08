// Offline outbox for channel messages (Telegram: a message typed without a connection waits with a
// clock and goes out by itself). The queue lives here, not in the chat screen: it is persisted in
// AsyncStorage per account, so it survives leaving the channel and restarting the app, and it is
// flushed on every «ready» of the socket whichever screen is open. The transport (how to send, where
// «ready» comes from) is attached once per login by useMessenger and dropped on sign-out.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { CommunityMessage } from './types';

export type OutboxItem = { key: string; communityId: string; channelId: string; text: string; replyTo?: number; createdAt: string };
/** A message the server refused for good (4xx): kept so the channel shows «не отправлено» when opened next. */
export type OutboxFailure = { item: OutboxItem; error: string; failedAt: string };
export type OutboxEvent = { type: 'sent'; item: OutboxItem; message: CommunityMessage } | { type: 'failed'; item: OutboxItem; error: string };
export type OutboxTransport = {
  /** The signed-in account: the queue on disk is bound to it, nothing of another account is ever sent. */
  userId: string;
  /** Sends one item; `item.key` goes along as `clientKey`, so a retry after a timeout never duplicates. */
  send: (item: OutboxItem) => Promise<CommunityMessage>;
  /** Socket listener hook (MessengerStore.onSocket): the outbox flushes on every «ready». */
  onSocket?: (listener: (data: any) => void) => () => void;
};

const KEY_PREFIX = 'linea.channel-outbox.v1';
export const storageKeyFor = (userId: string) => `${KEY_PREFIX}:${userId}`;
const failedKeyFor = (userId: string) => `${KEY_PREFIX}:${userId}:failed`;
/** More than this waiting means the connection is gone for good, not a bad minute: refuse with a clear message. */
export const OUTBOX_LIMIT = 200;
const FAILED_LIMIT = 20;
export const OUTBOX_FULL = `Слишком много сообщений ждут отправки (${OUTBOX_LIMIT}). Дождись соединения или отмени часть из них.`;
const EMPTY: OutboxItem[] = [];
const NO_FAILURES: OutboxFailure[] = [];

let userId: string | null = null;
let items: OutboxItem[] = EMPTY;
let failures: OutboxFailure[] = NO_FAILURES;
let loading: Promise<void> | null = null;
let transport: OutboxTransport | null = null;
let unsubscribeSocket: (() => void) | null = null;
let flushing = false; let flushAgain = false;
const listeners = new Set<() => void>();
const eventListeners = new Set<(event: OutboxEvent) => void>();
const emit = () => listeners.forEach(l => l());

/** Stored JSON → queue; anything malformed is dropped rather than crashing the flush. */
export function parseOutbox(raw: string | null): OutboxItem[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list.filter((item): item is OutboxItem => {
      if (!item || typeof item !== 'object') return false;
      const { key, communityId, channelId, text, replyTo } = item as Record<string, unknown>;
      if (typeof key !== 'string' || !key || key.length > 64 || seen.has(key)) return false;
      if (typeof communityId !== 'string' || typeof channelId !== 'string' || typeof text !== 'string' || !text.trim()) return false;
      if (replyTo !== undefined && typeof replyTo !== 'number') return false;
      seen.add(key); return true;
    }).map(item => ({ key: item.key, communityId: item.communityId, channelId: item.channelId, text: item.text, ...(item.replyTo ? { replyTo: item.replyTo } : {}), createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString() }));
  } catch { return []; }
}
function parseFailures(raw: string | null): OutboxFailure[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const result: OutboxFailure[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const { item, error, failedAt } = entry as Record<string, unknown>;
      const [parsed] = parseOutbox(JSON.stringify([item]));
      if (!parsed || result.some(f => f.item.key === parsed.key)) continue;
      result.push({ item: parsed, error: typeof error === 'string' && error ? error : 'Не удалось отправить.', failedAt: typeof failedAt === 'string' ? failedAt : new Date().toISOString() });
    }
    return result.slice(-FAILED_LIMIT);
  } catch { return []; }
}

/**
 * Writes the state of the signed-in account. The write waits for the initial read of the disk, so a
 * message queued right after login never clobbers what was stored before the restart; whatever is in
 * memory when the write runs is what goes to disk (the read merges into memory first).
 */
const persist = () => {
  const owner = userId; if (!owner) return;
  const key = storageKeyFor(owner), failedKey = failedKeyFor(owner);
  void (loading ?? Promise.resolve()).then(async () => {
    if (userId !== owner) return; // signed out meanwhile: the next account must not inherit this
    await AsyncStorage.setItem(key, JSON.stringify(items));
    await AsyncStorage.setItem(failedKey, JSON.stringify(failures));
  }).catch(() => {});
};
const commit = (next: OutboxItem[], nextFailures: OutboxFailure[] = failures) => {
  items = next.length ? next : EMPTY; failures = nextFailures.length ? nextFailures : NO_FAILURES; emit();
  persist();
};

/** Reads the queue of the signed-in account from disk once (restart): what was written offline before the restart goes out too. */
export function loadChannelOutbox(): Promise<void> {
  const owner = userId;
  if (!owner) return Promise.resolve();
  if (!loading) loading = Promise.all([AsyncStorage.getItem(storageKeyFor(owner)), AsyncStorage.getItem(failedKeyFor(owner))]).then(([raw, rawFailed]) => {
    if (userId !== owner) return;
    const stored = parseOutbox(raw), storedFailures = parseFailures(rawFailed);
    if (!stored.length && !storedFailures.length) return;
    // Items queued before the read finished stay after the stored ones (older first).
    const keys = new Set(stored.map(item => item.key));
    const merged = [...stored, ...items.filter(item => !keys.has(item.key))];
    const failedKeys = new Set(failures.map(f => f.item.key));
    items = merged.length ? merged : EMPTY;
    failures = [...storedFailures.filter(f => !failedKeys.has(f.item.key)), ...failures].slice(-FAILED_LIMIT);
    if (!failures.length) failures = NO_FAILURES;
    emit();
  }).catch(() => {});
  return loading;
}

/** A client key: 64 characters at most (the server limit), unique enough across devices. */
export const newOutboxKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * Queues a message. `key` lets the screen reuse the key of a send that timed out, so the retry is the
 * same message for the server. Throws OUTBOX_FULL beyond OUTBOX_LIMIT waiting messages.
 */
export function enqueueChannelMessage(fields: { communityId: string; channelId: string; text: string; replyTo?: number; key?: string }): OutboxItem {
  if (items.some(item => item.key === fields.key)) return items.find(item => item.key === fields.key)!;
  if (items.length >= OUTBOX_LIMIT) throw new Error(OUTBOX_FULL);
  const item: OutboxItem = { key: fields.key || newOutboxKey(), communityId: fields.communityId, channelId: fields.channelId, text: fields.text, ...(fields.replyTo ? { replyTo: fields.replyTo } : {}), createdAt: new Date().toISOString() };
  commit([...items, item]);
  return item;
}
/** «Отменить отправку» on a waiting message (also used after a definitive server refusal). */
export function removeChannelMessage(key: string) {
  if (items.some(item => item.key === key)) commit(items.filter(item => item.key !== key));
}
export function channelOutbox(channelId?: string): OutboxItem[] { return channelId === undefined ? items : items.filter(item => item.channelId === channelId); }
export function channelOutboxSize(): number { return items.length; }
/** Messages refused by the server (4xx) and not yet dismissed, for one channel or all. */
export function channelOutboxFailures(channelId?: string): OutboxFailure[] { return channelId === undefined ? failures : failures.filter(f => f.item.channelId === channelId); }
/** Dismisses one «не отправлено» entry (✕ in the channel). */
export function dismissChannelFailure(key: string) {
  if (failures.some(f => f.item.key === key)) commit(items, failures.filter(f => f.item.key !== key));
}
const recordFailure = (item: OutboxItem, error: string) => {
  const next = [...failures.filter(f => f.item.key !== item.key), { item, error, failedAt: new Date().toISOString() }].slice(-FAILED_LIMIT);
  commit(items.filter(waiting => waiting.key !== item.key), next);
};

/** 4xx means the server refused this very message (no permission, channel gone): retrying would never help. */
const refused = (error: unknown) => { const status = (error as { status?: unknown } | null)?.status; return typeof status === 'number' && status >= 400 && status < 500; };

/** Sends the queue in order; stops at the first network failure (tried again on the next «ready»). */
export async function flushChannelOutbox(): Promise<void> {
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    await loadChannelOutbox();
    do {
      flushAgain = false;
      while (transport && items.length) {
        const item = items[0]; const active = transport;
        try {
          const message = await active.send(item);
          if (transport !== active) return; // signed out while sending: nothing of this account is touched any more
          removeChannelMessage(item.key);
          eventListeners.forEach(l => { try { l({ type: 'sent', item, message }); } catch { /* keep others */ } });
        } catch (error) {
          if (transport !== active) return;
          if (!refused(error)) return;
          const text = error instanceof Error && error.message ? error.message : 'Не удалось отправить.';
          recordFailure(item, text);
          eventListeners.forEach(l => { try { l({ type: 'failed', item, error: text }); } catch { /* keep others */ } });
        }
      }
    } while (flushAgain);
  } finally { flushing = false; }
}

/**
 * Registers the signed-in account, how to send (the API) and where «ready» comes from. Called once
 * per login (useMessenger), kept while the account stays signed in, whichever screen is open.
 */
export function attachChannelOutbox(next: OutboxTransport) {
  if (userId !== next.userId) {
    // Another account: forget the previous queue in memory (its disk copy stays with that account).
    // What was queued while nobody was attached yet belongs to the account signing in now.
    if (userId !== null) { items = EMPTY; failures = NO_FAILURES; }
    userId = next.userId; loading = null; emit();
  }
  const sameSocket = transport?.onSocket === next.onSocket;
  transport = next;
  if (!sameSocket) {
    unsubscribeSocket?.(); unsubscribeSocket = null;
    if (next.onSocket) unsubscribeSocket = next.onSocket(data => { if (data?.type === 'ready') void flushChannelOutbox(); });
  }
  void flushChannelOutbox();
}
/**
 * Sign-out / messenger teardown: the transport and the queue in memory are dropped so nothing of the
 * previous account can be sent from the next one. `purge` (a real logout, an expired session) also
 * wipes the account's queue from disk; without it (the messenger remounting) the queue is read back
 * on the next attach.
 */
export function resetChannelOutbox(options: { purge?: boolean } = {}) {
  unsubscribeSocket?.(); unsubscribeSocket = null; transport = null;
  const owner = userId; userId = null; loading = null;
  items = EMPTY; failures = NO_FAILURES; emit();
  if (options.purge && owner) void AsyncStorage.multiRemove([storageKeyFor(owner), failedKeyFor(owner)]).catch(() => {});
}
/** The account whose queue is attached (tests, diagnostics). */
export function channelOutboxOwner(): string | null { return userId; }

export function onChannelOutbox(listener: (event: OutboxEvent) => void): () => void { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
// Stable snapshots per channel: useSyncExternalStore needs the same array while nothing changed.
const snapshots = new Map<string, { source: OutboxItem[]; list: OutboxItem[] }>();
const snapshot = (channelId: string) => {
  const cached = snapshots.get(channelId);
  if (cached && cached.source === items) return cached.list;
  const list = items.filter(item => item.channelId === channelId);
  snapshots.set(channelId, { source: items, list: list.length ? list : EMPTY });
  return list.length ? list : EMPTY;
};
const failureSnapshots = new Map<string, { source: OutboxFailure[]; list: OutboxFailure[] }>();
const failureSnapshot = (channelId: string) => {
  const cached = failureSnapshots.get(channelId);
  if (cached && cached.source === failures) return cached.list;
  const list = failures.filter(f => f.item.channelId === channelId);
  failureSnapshots.set(channelId, { source: failures, list: list.length ? list : NO_FAILURES });
  return list.length ? list : NO_FAILURES;
};
/** Messages of this channel still waiting («ожидает отправки»). */
export function useChannelOutbox(channelId: string): OutboxItem[] {
  return useSyncExternalStore(subscribe, () => snapshot(channelId), () => EMPTY);
}
/** Messages of this channel the server refused («не отправлено»), until dismissed. */
export function useChannelOutboxFailures(channelId: string): OutboxFailure[] {
  return useSyncExternalStore(subscribe, () => failureSnapshot(channelId), () => NO_FAILURES);
}
