import type { LocalFile } from '../types';

export type AttachmentKind = 'photo' | 'video' | 'audio' | 'file';
export type AttachmentSelection = { id: string; kind: AttachmentKind; file: LocalFile; assetId?: string };
export type GalleryItem = AttachmentSelection & { kind: 'photo' | 'video'; width: number; height: number; duration: number | null };
export function addSelections<T extends { id: string }>(current: T[], additions: T[], limit: number): T[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of additions) if (!byId.has(item.id)) byId.set(item.id, item);
  if (byId.size > limit) throw new Error(limit ? `В этом сообщении осталось мест для вложений: ${limit}. Убери лишнее из выбора.` : 'В сообщении уже максимальное число вложений. Сначала отправь или убери часть файлов.');
  return [...byId.values()];
}

export function toggleSelection<T extends { id: string }>(current: T[], item: T, limit: number): T[] {
  return current.some(value => value.id === item.id) ? current.filter(value => value.id !== item.id) : addSelections(current, [item], limit);
}

export function mergeGalleryPage<T extends { id: string }>(current: T[], page: T[]): T[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of page) byId.set(item.id, item);
  return [...byId.values()];
}

/** The class-based SDK57 MediaLibrary returns video duration in milliseconds. */
export function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds <= 0) return 'Видео';
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}
