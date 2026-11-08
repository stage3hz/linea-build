/**
 * Local full-text index over the decrypted history (G029). It lives only in memory and is
 * derived from the device's encrypted vault cache (CryptoService.history) plus every message
 * decrypted while the app runs; nothing here ever leaves the device or touches the network.
 *
 * Matching: every word of the query must occur in the message text or the sender's name as a
 * substring (so a prefix matches too), case-insensitive, «ё» = «е», Cyrillic «й» = «и», other
 * diacritics folded (NFKD). Memory is bounded: the newest `maxEntries` messages stay, and the text
 * kept per entry is capped. A message deleted for everyone leaves the index (and stays refused, see
 * `tombstone`); an edit replaces the text under the same key (see `edit`).
 */
export type IndexEntry = { chatId: string; senderId: string; clientId: string; text: string; sentAt: string; attachmentName?: string };
export type SearchHit = IndexEntry & { key: string };
export type SearchGroup = { chatId: string; latest: string; hits: SearchHit[] };
export type SearchOptions = { names?: (senderId: string, chatId: string) => string; limit?: number; perChat?: number; chats?: ReadonlySet<string> };

/** Text kept per entry (the haystack is a normalized copy of it, so both stay small). */
const TEXT_CAP = 300;
export const entryKey = (entry: Pick<IndexEntry, 'chatId' | 'senderId' | 'clientId'>) => `${entry.chatId}:${entry.senderId}:${entry.clientId}`;
export type EntryRef = Pick<IndexEntry, 'chatId' | 'senderId' | 'clientId'>;

/** Lower-case, ё→е, й→и, combining marks stripped, whitespace collapsed. */
export function normalize(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/й/g, 'и').replace(/\s+/g, ' ').trim();
}
/** Query words; an empty list means «nothing to search for». */
export const queryTerms = (query: string): string[] => normalize(query).split(' ').filter(Boolean);

/** A short piece of the text around the first match, for the result row. */
export function snippet(text: string, query: string, width = 90): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const terms = queryTerms(query); const haystack = normalize(plain);
  // normalize() keeps one char per char (only combining marks are dropped, and those are rare in chat text), so offsets line up closely enough.
  let at = -1;
  for (const term of terms) { const found = haystack.indexOf(term); if (found >= 0 && (at < 0 || found < at)) at = found; }
  if (at <= 24) return plain.slice(0, width);
  return '…' + plain.slice(at - 20, at - 20 + width);
}

type Stored = { entry: IndexEntry; haystack: string; time: number };

export class MessageIndex {
  private entries = new Map<string, Stored>();
  /**
   * Messages deleted for everyone: their key is refused afterwards. Needed because a page is hydrated
   * through Promise.all, so the deletion may be indexed before the message it deletes.
   */
  private deleted = new Set<string>();
  /** Messages edited: key → time of the newest edit seen. The edited text wins over the original whichever arrives first. */
  private edited = new Map<string, number>();
  private oldest = Infinity;
  readonly maxEntries: number;
  constructor(maxEntries = 10000) { this.maxEntries = maxEntries; }
  get size() { return this.entries.size; }
  /** sentAt (ms) of the oldest message kept, Infinity while empty; with a full index, anything older is not worth a slot. */
  get oldestTime() { return this.oldest; }
  get full() { return this.entries.size >= this.maxEntries; }
  /**
   * Adds the original text of a message, or replaces it. Returns true when something changed. A key
   * deleted for everyone is refused; a key already edited keeps the edited text (only the time and
   * the file name are taken from the original).
   */
  add(entry: IndexEntry): boolean {
    const key = entryKey(entry);
    if (this.deleted.has(key)) return false;
    const previous = this.entries.get(key);
    if (previous && this.edited.has(key)) return this.store(key, { ...previous.entry, sentAt: entry.sentAt, ...(entry.attachmentName ? { attachmentName: entry.attachmentName.slice(0, 240) } : {}) }, previous);
    return this.store(key, entry, previous);
  }
  /** The new text of a message after an edit (`at`: when the edit was sent). The message keeps its own time once that is known. */
  edit(ref: EntryRef, text: string, at: string): boolean {
    const key = entryKey(ref);
    if (this.deleted.has(key)) return false;
    const time = Date.parse(at) || 0;
    const seen = this.edited.get(key);
    if (seen !== undefined && seen > time) return false; // an older edit arriving late
    this.remember(this.edited, key, time);
    const previous = this.entries.get(key);
    return this.store(key, { ...ref, text, sentAt: previous?.entry.sentAt ?? at, ...(previous?.entry.attachmentName ? { attachmentName: previous.entry.attachmentName } : {}) }, previous);
  }
  private store(key: string, entry: IndexEntry, previous: Stored | undefined): boolean {
    const text = (entry.text || '').slice(0, TEXT_CAP), attachmentName = entry.attachmentName?.slice(0, 240);
    if (!text.trim() && !attachmentName) { if (previous) { this.entries.delete(key); return true; } return false; }
    const time = Date.parse(entry.sentAt) || 0;
    if (previous && previous.entry.text === text && previous.entry.attachmentName === attachmentName && previous.time === time) return false;
    const haystack = normalize(`${text} ${attachmentName || ''}`);
    const stored: Stored = { entry: { ...entry, text, ...(attachmentName ? { attachmentName } : {}) }, haystack, time };
    if (!stored.entry.attachmentName) delete stored.entry.attachmentName;
    if (!previous && this.entries.size >= this.maxEntries) {
      if (time <= this.oldest) return false; // older than everything kept: not worth a slot
      this.evict();
    }
    this.entries.set(key, stored);
    if (time < this.oldest) this.oldest = time;
    return true;
  }
  addAll(entries: Iterable<IndexEntry>): number { let added = 0; for (const entry of entries) if (this.add(entry)) added++; return added; }
  /** Deleted for everyone: the entry goes and the key stays refused (the original may still be on its way). Returns true when something changed. */
  tombstone(ref: EntryRef): boolean {
    const key = entryKey(ref);
    const had = this.entries.delete(key);
    const fresh = !this.deleted.has(key);
    this.remember(this.deleted, key);
    this.edited.delete(key);
    return had || fresh;
  }
  /** Drops the entry only (a message hidden for me, a chat left); nothing is remembered. */
  remove(ref: EntryRef): boolean { return this.entries.delete(entryKey(ref)); }
  removeChat(chatId: string): number {
    let removed = 0;
    for (const [key, stored] of this.entries) if (stored.entry.chatId === chatId) { this.entries.delete(key); removed++; }
    const prefix = `${chatId}:`;
    for (const key of this.deleted) if (key.startsWith(prefix)) this.deleted.delete(key);
    for (const key of this.edited.keys()) if (key.startsWith(prefix)) this.edited.delete(key);
    return removed;
  }
  clear() { this.entries.clear(); this.deleted.clear(); this.edited.clear(); this.oldest = Infinity; }
  /** The tombstone and edit lists stay bounded too: the oldest noted key gives way. */
  private remember(list: Set<string> | Map<string, number>, key: string, value = 0) {
    if (list instanceof Set) list.add(key); else list.set(key, value);
    if (list.size > this.maxEntries) { const first = list.keys().next().value; if (first !== undefined) list.delete(first); }
  }
  /** Drops the oldest tenth so inserts stay cheap on average. */
  private evict() {
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].time - b[1].time);
    const drop = Math.max(1, Math.floor(sorted.length / 10));
    for (let index = 0; index < drop; index++) this.entries.delete(sorted[index][0]);
    this.oldest = sorted[drop]?.[1].time ?? Infinity;
  }
  /** Results grouped by chat, newest chat (by its newest hit) first, hits newest first. */
  search(query: string, options: SearchOptions = {}): SearchGroup[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const limit = options.limit ?? 200, perChat = options.perChat ?? 50;
    const nameCache = new Map<string, string>();
    const nameOf = (senderId: string, chatId: string) => {
      if (!options.names) return '';
      const key = `${chatId}:${senderId}`; let name = nameCache.get(key);
      if (name === undefined) { name = normalize(options.names(senderId, chatId) || ''); nameCache.set(key, name); }
      return name;
    };
    const hits: (Stored & { key: string })[] = [];
    for (const [key, stored] of this.entries) {
      if (options.chats && !options.chats.has(stored.entry.chatId)) continue;
      let ok = true;
      for (const term of terms) {
        if (stored.haystack.includes(term)) continue;
        const name = nameOf(stored.entry.senderId, stored.entry.chatId);
        if (name && name.includes(term)) continue;
        ok = false; break;
      }
      if (ok) hits.push({ ...stored, key });
    }
    hits.sort((a, b) => b.time - a.time);
    const groups = new Map<string, SearchGroup>(); let total = 0;
    for (const hit of hits) {
      if (total >= limit) break;
      let group = groups.get(hit.entry.chatId);
      if (!group) { group = { chatId: hit.entry.chatId, latest: hit.entry.sentAt, hits: [] }; groups.set(hit.entry.chatId, group); }
      if (group.hits.length >= perChat) continue;
      group.hits.push({ ...hit.entry, key: hit.key }); total++;
    }
    return [...groups.values()];
  }
}
