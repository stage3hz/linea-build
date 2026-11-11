// A tap on a reply quote, as in Telegram: when the original is not loaded yet, earlier pages are loaded
// one after another (a spinner on the quote) until it shows up; then the list scrolls to it and it flashes.
// An original that was deleted (or hidden «for me») is not searched for: a short «Сообщение удалено».
import type { Message } from './types';

/** At most this many earlier pages are loaded for one tap (a page is 50 messages on the server). */
export const JUMP_PAGE_CAP = 30;
/** How long the found message stays highlighted. */
export const JUMP_FLASH_MS = 1400;

export type ReplyJump = { clientId: string; fromKey?: string; pages: number };
export type JumpInput = {
  /** The original is in the loaded list now. */
  found: boolean;
  /** It is known to be gone: a delete aimed at it is loaded, or it is loaded but hidden for me. */
  deleted: boolean;
  /** A page is being loaded right now. */
  loading: boolean;
  /** The server has earlier messages. */
  hasMore: boolean;
  /** Pages already loaded for this jump. */
  pages: number;
  cap?: number;
};
export type JumpStep = 'scroll' | 'wait' | 'load' | 'deleted' | 'too-far';

export function nextJumpStep({ found, deleted, loading, hasMore, pages, cap = JUMP_PAGE_CAP }: JumpInput): JumpStep {
  if (found) return 'scroll';
  if (deleted) return 'deleted';
  if (loading) return 'wait';
  // The whole history is here and the message is not: it no longer exists.
  if (!hasMore) return 'deleted';
  if (pages >= cap) return 'too-far';
  return 'load';
}

/** Gone for good: a delete for it is among the loaded messages, or it is loaded but folded out of the view. */
export function knownDeleted(raw: readonly Pick<Message, 'clientId' | 'meta'>[], clientId: string, inView: boolean): boolean {
  if (inView) return false;
  return raw.some(message => message.clientId === clientId || (message.meta?.action?.type === 'delete' && message.meta.action.target === clientId));
}

type RowLike = { message?: { clientId: string }; album?: { message?: { clientId: string } }[] };
/** The list row that shows this message (an album row shows several). */
export function rowIndexOf(rows: readonly RowLike[], clientId: string): number {
  return rows.findIndex(row => row.message?.clientId === clientId || !!row.album?.some(part => part.message?.clientId === clientId));
}
