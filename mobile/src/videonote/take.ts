// What happens to a finished circle take (pure, covered by test/media-videonote-take.test.mjs).
// Telegram: a take shorter than a second is dropped silently in hold mode, with a hint in the full-screen
// recorder; a cancelled, dropped or failed take never leaves its file in the cache.
export const VIDEO_NOTE_MIN_MS = 1000;

export type TakeOutcome =
  | { action: 'send'; uri: string }
  | { action: 'discard'; close: boolean; deleteUri: string | null }
  | { action: 'error'; message: string; deleteUri: string | null };

export function resolveTake({ uri, durationMs, cancelled, hold, locked, failed }: {
  uri: string | null | undefined; durationMs: number; cancelled: boolean; hold: boolean; locked: boolean; failed?: string | null;
}): TakeOutcome {
  const deleteUri = uri || null;
  // cancel() has already closed the recorder; only the file is left to remove.
  if (cancelled) return { action: 'discard', close: false, deleteUri };
  // While the finger holds the button there is no «close» control, so an error (the native recorder
  // rejects a stop before the first frame) is treated as a too-short take. After a lock the error is shown.
  if (failed) return hold && (!locked || durationMs < VIDEO_NOTE_MIN_MS) ? { action: 'discard', close: true, deleteUri } : { action: 'error', message: failed, deleteUri };
  if (!uri) return hold && !locked ? { action: 'discard', close: true, deleteUri: null } : { action: 'error', message: 'Не удалось записать видео.', deleteUri: null };
  if (durationMs < VIDEO_NOTE_MIN_MS) return hold ? { action: 'discard', close: true, deleteUri } : { action: 'error', message: 'Слишком короткое видео — запиши хотя бы секунду.', deleteUri };
  return { action: 'send', uri };
}
