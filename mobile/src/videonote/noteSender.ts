// Sends a recorded circle through the encrypted upload and keeps it in the chat until it is really sent
// (covered by test/videonote-outbox.test.mjs). A failure leaves the circle as «not sent» with its recording,
// so «Повторить отправку» uploads the same take again; nothing is dropped silently.
import type { Attachment, LocalFile } from '../types';
import { dispatchNote, findNote, noteError, type NoteReply } from './noteOutbox';

export type NoteDeps = {
  upload: (file: LocalFile, onProgress: (sent: number, total: number) => void) => Promise<Attachment>;
  /** Hands the uploaded circle to the message outbox (which has its own «failed / Повторить» state). */
  send: (chatId: string, attachment: Attachment, reply?: NoteReply) => void;
  deleteFile: (uri: string) => Promise<void>;
  /** circle-<ms>.mp4: the name that makes receivers show it as a round video. */
  fileName: () => string;
  thumbnail?: (uri: string) => Promise<string>;
  /** Moves the sent take into the media cache under the uploaded attachment (true: the file is taken over). */
  adopt?: (attachment: Attachment, uri: string) => Promise<boolean>;
};
export type NoteResult = 'sent' | 'failed' | 'cancelled' | 'busy';

const running = new Set<string>(), cancelled = new Set<string>();
const quietDelete = (deps: NoteDeps, uri: string | undefined) => uri ? deps.deleteFile(uri).catch(() => {}) : Promise.resolve();

export function queueNote(deps: NoteDeps, take: { id: string; chatId: string; uri: string; durationMs: number; reply?: NoteReply; createdAt?: number }): Promise<NoteResult> {
  dispatchNote({ type: 'add', note: { id: take.id, chatId: take.chatId, uri: take.uri, durationMs: take.durationMs, createdAt: take.createdAt ?? Date.now(), progress: 0, state: 'sending', ...(take.reply ? { reply: take.reply } : {}) } });
  if (deps.thumbnail) void deps.thumbnail(take.uri).then(thumb => { if (findNote(take.id)) dispatchNote({ type: 'thumb', id: take.id, thumb }); else void quietDelete(deps, thumb); }, () => {});
  return runNote(deps, take.id);
}

/** Uploads (or, after a failure, uploads again) the circle `id`. */
export async function runNote(deps: NoteDeps, id: string): Promise<NoteResult> {
  if (running.has(id)) return 'busy';
  const start = findNote(id);
  if (!start) return 'cancelled';
  running.add(id); cancelled.delete(id);
  dispatchNote({ type: 'retry', id });
  const dropped = async () => { cancelled.delete(id); await quietDelete(deps, start.uri); return 'cancelled' as const; };
  try {
    const uploaded = await deps.upload({ uri: start.uri, name: 'video.mp4', mimeType: 'video/mp4' }, (sent, total) => dispatchNote({ type: 'progress', id, sent, total }));
    // ✕ while uploading: uploads cannot be aborted, so the finished upload is simply not sent.
    if (cancelled.has(id) || !findNote(id)) return await dropped();
    const durationMs = uploaded.media?.durationMs || Math.round(start.durationMs);
    const sent: Attachment = { ...uploaded, name: deps.fileName(), mimeType: 'video/mp4', media: { ...(uploaded.media || {}), durationMs } };
    // The take becomes the sent bubble's cached file before the bubble appears: no second download.
    const adopted = deps.adopt ? await deps.adopt(sent, start.uri).catch(() => false) : false;
    deps.send(start.chatId, sent, start.reply);
    const note = findNote(id);
    dispatchNote({ type: 'remove', id });
    if (!adopted) await quietDelete(deps, start.uri);
    await quietDelete(deps, note?.thumb);
    return 'sent';
  } catch (error) {
    if (cancelled.has(id) || !findNote(id)) return await dropped();
    console.warn('[videonote] send failed:', error instanceof Error ? error.message : String(error));
    dispatchNote({ type: 'fail', id, error: noteError(error) });
    return 'failed';
  } finally { running.delete(id); }
}

/** ✕ / «Удалить»: the circle leaves the chat; its recording is deleted now, or when a running upload ends. */
export function discardNote(deps: NoteDeps, id: string): void {
  const note = findNote(id);
  if (!note) return;
  dispatchNote({ type: 'remove', id });
  void quietDelete(deps, note.thumb);
  if (running.has(id)) cancelled.add(id); else void quietDelete(deps, note.uri);
}
