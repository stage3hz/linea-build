// «Избранное»: личные заметки и сохранённые сообщения.
// The list is stored only in the device's encrypted vault; attachments keep
// pointing at the already end-to-end encrypted files on the server.
import type { Attachment } from '../types';
import { validAttachment } from '../e2ee/core.ts';

export const SAVED_LIMIT = 5000;
export const SAVED_TEXT_LIMIT = 8000;
export type SavedOrigin = { chatId: string; clientId: string; author: string; sentAt: string };
export type SavedItem = { id: string; savedAt: string; text: string; attachment: Attachment | null; origin?: SavedOrigin; editedAt?: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const date = (value: unknown) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

function validOrigin(value: unknown): value is SavedOrigin {
  return record(value) && typeof value.chatId === 'string' && uuid.test(value.chatId) && typeof value.clientId === 'string' && uuid.test(value.clientId)
    && typeof value.author === 'string' && value.author.length > 0 && value.author.length <= 80 && date(value.sentAt);
}

export function validSavedItem(value: unknown): value is SavedItem {
  if (!record(value) || typeof value.id !== 'string' || !uuid.test(value.id) || !date(value.savedAt)) return false;
  if (typeof value.text !== 'string' || value.text.length > SAVED_TEXT_LIMIT) return false;
  if (!validAttachment(value.attachment ?? null) || (!value.text.trim() && !value.attachment)) return false;
  if (value.origin !== undefined && !validOrigin(value.origin)) return false;
  return value.editedAt === undefined || date(value.editedAt);
}

/** Reads the stored list, dropping anything malformed instead of failing the whole screen. */
export function parseSaved(raw: string | null): SavedItem[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(validSavedItem).slice(-SAVED_LIMIT);
  } catch { return []; }
}

export const originKey = (origin: Pick<SavedOrigin, 'chatId' | 'clientId'>) => `${origin.chatId}:${origin.clientId}`;

/** Adds an item at the end. A message that is already saved is not duplicated. */
export function addSaved(list: SavedItem[], item: SavedItem): { list: SavedItem[]; added: boolean } {
  if (!validSavedItem(item)) throw new Error('Не удалось сохранить: сообщение пустое или слишком длинное.');
  if (list.some(entry => entry.id === item.id) || (item.origin && list.some(entry => entry.origin && originKey(entry.origin) === originKey(item.origin!)))) return { list, added: false };
  if (list.length >= SAVED_LIMIT) throw new Error(`В Избранном уже ${SAVED_LIMIT} записей. Удали старые, чтобы добавить новые.`);
  return { list: [...list, item], added: true };
}

export function removeSaved(list: SavedItem[], id: string): SavedItem[] { return list.filter(item => item.id !== id); }

export function editSaved(list: SavedItem[], id: string, text: string, now: string): SavedItem[] {
  const next = text.trim();
  return list.map(item => {
    if (item.id !== id) return item;
    const edited = { ...item, text: next, editedAt: now };
    if (!validSavedItem(edited)) throw new Error('Текст пустой или слишком длинный.');
    return edited;
  });
}

export function searchSaved(list: SavedItem[], query: string): SavedItem[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return list;
  return list.filter(item => `${item.text} ${item.attachment?.name || ''} ${item.origin?.author || ''}`.toLocaleLowerCase('ru').includes(needle));
}
