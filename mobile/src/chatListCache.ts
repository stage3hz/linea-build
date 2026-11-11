import type { Chat, Message } from './types';

/**
 * What the chat list and the open chats showed last time, kept in this device's encrypted vault
 * (SQLCipher, next to the decrypted message cache — never AsyncStorage, never the server). Like Telegram,
 * the app opens with it at once and without a network; a successful refresh from the server replaces it.
 * The ciphertext of a message (`encrypted`) is left out: only what was already shown is kept.
 */
export const CHAT_LIST_CACHE = 'chats:v1';
export const CHAT_LIST_LIMIT = 500;
export const CHAT_PAGE_LIMIT = 60;
const CHAT_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** Vault key of a chat's last shown page of messages. */
export const chatPageCacheKey = (chatId: string): string | null => CHAT_ID.test(chatId) ? `page:v1:${chatId}` : null;
export const isCacheName = (name: string): boolean => name === CHAT_LIST_CACHE || /^page:v1:[A-Za-z0-9_-]{1,80}$/.test(name);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stripMessage = (message: Message): Message => { const { encrypted: _ciphertext, ...rest } = message; return rest; };
function validMessage(value: unknown): value is Message {
  return isObject(value) && typeof value.id === 'number' && typeof value.chatId === 'string' && typeof value.senderId === 'string'
    && typeof value.clientId === 'string' && typeof value.text === 'string' && typeof value.createdAt === 'string'
    && (value.attachment === null || isObject(value.attachment));
}
function validChat(value: unknown): value is Chat {
  return isObject(value) && typeof value.id === 'string' && isObject(value.peer) && typeof value.peer.id === 'string'
    && typeof value.updatedAt === 'string' && typeof value.unreadCount === 'number'
    && (value.lastMessage === null || validMessage(value.lastMessage));
}

export function encodeChatList(chats: readonly Chat[]): string {
  return JSON.stringify(chats.slice(0, CHAT_LIST_LIMIT).map(chat => chat.lastMessage ? { ...chat, lastMessage: stripMessage(chat.lastMessage) } : chat));
}
/** The cached list, newest first; anything damaged or of another account reads as nothing. */
export function decodeChatList(raw: string | null | undefined): Chat[] {
  if (!raw) return [];
  let value: unknown; try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((chat): chat is Chat => validChat(chat) && !seen.has(chat.id) && !!seen.add(chat.id)).slice(0, CHAT_LIST_LIMIT)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The newest CHAT_PAGE_LIMIT messages of a chat as shown (Mesh copies are left out: the server's copy replaces them). */
export function encodeChatPage(messages: readonly Message[], hasMore: boolean): string {
  const kept = messages.filter(message => !message.mesh && message.id > 0);
  const page = kept.slice(-CHAT_PAGE_LIMIT).map(stripMessage);
  return JSON.stringify({ messages: page, hasMore: hasMore || kept.length > page.length });
}
export function decodeChatPage(raw: string | null | undefined, chatId: string): { messages: Message[]; hasMore: boolean } | null {
  if (!raw) return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!isObject(value) || !Array.isArray(value.messages)) return null;
  const messages = value.messages.filter((message): message is Message => validMessage(message) && message.chatId === chatId).sort((a, b) => a.id - b.id);
  return messages.length ? { messages, hasMore: value.hasMore === true } : null;
}

/** The list the cache restores: only while nothing newer (a server answer, a socket message) is on screen. */
export function restoreChats(current: readonly Chat[], cached: readonly Chat[], serverLoaded: boolean): readonly Chat[] {
  if (serverLoaded || !cached.length) return current;
  if (!current.length) return cached;
  // A socket message or an opened chat arrived first: those entries win, the rest come from the cache.
  const have = new Set(current.map(chat => chat.id));
  return [...current, ...cached.filter(chat => !have.has(chat.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
