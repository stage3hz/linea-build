import type { Message } from './types';

/** Two message lists into one, by id. The Mesh copy of a message goes once its server copy is here. */
export const mergeMessages = (a: Message[], b: Message[]) => {
  const all = Array.from(new Map([...a, ...b].map(m => [m.id, m])).values());
  const fromServer = new Set(all.filter(m => !m.mesh).map(m => `${m.senderId}:${m.clientId}`));
  return all.filter(m => !m.mesh || !fromServer.has(`${m.senderId}:${m.clientId}`)).sort((x, y) => x.id - y.id);
};

/**
 * A page from the server applied to what is loaded. An older page is only added. The latest page
 * (reconnect, return from the background, chat opened again) replaces its own id range, so a
 * message deleted on the server disappears, but keeps the history scrolled up earlier («Более
 * ранние сообщения») instead of throwing it away, and keeps messages that arrived over the socket
 * while the page was in flight. The older history stays only when the page overlaps it: a page
 * disjoint from what is loaded (more messages arrived while away than a page holds) would leave
 * a gap between them, so it replaces everything and the server flag speaks. When the page is the
 * whole chat (no more above it), the older leftovers were deleted on the server and go too. Mesh
 * messages are local and always stay.
 */
export function applyPage(prev: Message[], page: Message[], options: { older: boolean; hasMore: boolean; prevHasMore?: boolean }): { messages: Message[]; hasMore: boolean } {
  if (options.older) return { messages: mergeMessages(page, prev), hasMore: options.hasMore };
  if (!page.length) return { messages: prev.filter(m => m.mesh), hasMore: false };
  const minId = page[0].id, maxId = page[page.length - 1].id;
  // Only ids inside the page count as overlap: a message that arrived over the socket after the page
  // was requested (id > maxId) says nothing about whether the history below the page is contiguous.
  const overlap = prev.some(m => !m.mesh && m.id >= minId && m.id <= maxId);
  const kept = prev.filter(m => m.mesh || m.id > maxId || (m.id < minId && options.hasMore && overlap));
  const olderKept = kept.some(m => !m.mesh && m.id < minId);
  return { messages: mergeMessages(page, kept), hasMore: olderKept ? options.prevHasMore ?? options.hasMore : options.hasMore };
}
