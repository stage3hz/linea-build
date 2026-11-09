// Round videos on their way out (Telegram: the sent circle stays in the chat with an upload ring; when the
// upload fails it stays as «not sent» with «Повторить отправку» instead of vanishing).
// Pure state + a tiny module-level store (covered by test/videonote-outbox.test.mjs): the list outlives the
// chat screen, so leaving the chat mid-upload neither loses the circle nor its file.
import { nativeErrorMessage } from '../media/nativeError';

export type NoteReply = { clientId: string; senderId: string; preview: string };
export type NoteUpload = {
  id: string; chatId: string; uri: string; durationMs: number; createdAt: number;
  progress: number; state: 'sending' | 'failed'; thumb?: string; error?: string; reply?: NoteReply;
};
export type NoteEvent =
  | { type: 'add'; note: NoteUpload }
  | { type: 'progress'; id: string; sent: number; total: number }
  | { type: 'thumb'; id: string; thumb: string }
  | { type: 'fail'; id: string; error: string }
  | { type: 'retry'; id: string }
  | { type: 'remove'; id: string };

export const NOTE_SEND_FALLBACK = 'Не удалось отправить видеосообщение.';

export function reduceNotes(list: readonly NoteUpload[], event: NoteEvent): NoteUpload[] {
  const patch = (id: string, change: (note: NoteUpload) => NoteUpload | null) => {
    let changed = false;
    const next: NoteUpload[] = [];
    for (const note of list) {
      if (note.id !== id) { next.push(note); continue; }
      const updated = change(note);
      if (updated !== note) changed = true;
      if (updated) next.push(updated);
    }
    return changed ? next : list as NoteUpload[];
  };
  switch (event.type) {
    case 'add': return [...list.filter(note => note.id !== event.note.id), event.note];
    // Progress only moves forward while sending (a late callback after a failure changes nothing).
    case 'progress': {
      if (!(event.total > 0) || !Number.isFinite(event.sent)) return list as NoteUpload[];
      const value = Math.max(0, Math.min(1, event.sent / event.total));
      return patch(event.id, note => note.state === 'sending' && value > note.progress ? { ...note, progress: value } : note);
    }
    case 'thumb': return patch(event.id, note => ({ ...note, thumb: event.thumb }));
    case 'fail': return patch(event.id, note => ({ ...note, state: 'failed', error: event.error || NOTE_SEND_FALLBACK, progress: 0 }));
    case 'retry': return patch(event.id, note => note.state === 'failed' ? { ...note, state: 'sending', error: undefined, progress: 0 } : note);
    case 'remove': return patch(event.id, () => null);
  }
}

/** Oldest first: they are drawn top to bottom in one cell under the newest message (the newest at the bottom). */
export const notesFor = (list: readonly NoteUpload[], chatId: string) => list.filter(note => note.chatId === chatId).sort((a, b) => a.createdAt - b.createdAt);

/** A readable reason for the failed circle: native class names, codes and source locations are dropped. */
export function noteError(error: unknown): string {
  const text = nativeErrorMessage(error, '');
  if (!text || /^(?:undefined|null|\[object Object\])$/.test(text)) return NOTE_SEND_FALLBACK;
  if (/network request failed|failed to fetch|timed? ?out|ECONN|ENOTFOUND/i.test(text)) return 'Нет связи с сервером. Видеосообщение не отправлено — повтори, когда появится интернет.';
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

// ---- module store (one per app process) ----
let notes: NoteUpload[] = [];
const listeners = new Set<() => void>();
export function dispatchNote(event: NoteEvent): void {
  const next = reduceNotes(notes, event);
  if (next === notes) return;
  notes = next;
  for (const listener of [...listeners]) listener();
}
export const getNotes = (): NoteUpload[] => notes;
export function subscribeNotes(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const findNote = (id: string): NoteUpload | undefined => notes.find(note => note.id === id);
/** True while a circle (sending or failed, waiting for «Повторить») still needs this recorded file. */
export function noteFileInUse(uri: string): boolean { return notes.some(note => note.uri === uri); }
