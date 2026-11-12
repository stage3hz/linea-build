// The same message over and over (anti-spam).
//
// The same text may be sent to a chat REPEAT_FREE times in a row. After that every further copy has to wait:
// REPEAT_WAIT_MS after the previous one, and REPEAT_STEP_MS longer with each copy (10 s, 15 s, 20 s, …).
// Any other message starts the count again; so does REPEAT_FORGET_MS without that text.
// «The same»: compared without case, and with runs of spaces and line breaks taken as one space.
//
// Private chats are end-to-end encrypted — the server cannot see what is repeated, so there this rule is kept by
// the app itself (it stops ordinary flooding; a rebuilt app could ignore it). In communities, where the server
// reads the text, the server keeps the same rule too (server/src/repeatguard.js).
export const REPEAT_FREE = 5;
export const REPEAT_WAIT_MS = 10_000;
export const REPEAT_STEP_MS = 5_000;
export const REPEAT_FORGET_MS = 10 * 60_000;

export type RepeatState = { key: string; count: number; lastAt: number };
export type RepeatVerdict = { allowed: true; state: RepeatState } | { allowed: false; waitMs: number };

export const repeatKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether `text` may be sent now, given what was sent to this chat before (`state`, null at first). */
export function checkRepeat(state: RepeatState | null | undefined, text: string, now: number): RepeatVerdict {
  const key = repeatKey(text);
  if (!key || !state || state.key !== key || now - state.lastAt >= REPEAT_FORGET_MS) return { allowed: true, state: { key, count: 1, lastAt: now } };
  if (state.count < REPEAT_FREE) return { allowed: true, state: { key, count: state.count + 1, lastAt: now } };
  const need = REPEAT_WAIT_MS + REPEAT_STEP_MS * (state.count - REPEAT_FREE);
  const waited = now - state.lastAt;
  return waited >= need ? { allowed: true, state: { key, count: state.count + 1, lastAt: now } } : { allowed: false, waitMs: need - waited };
}

const chats = new Map<string, RepeatState>();
/** The app's own record, per chat, for this run. Returns 0 when the text may be sent (and counts it), else the seconds to wait. */
export function repeatWait(chatId: string, text: string, now = Date.now()): number {
  const verdict = checkRepeat(chats.get(chatId), text, now);
  if (!verdict.allowed) return Math.max(1, Math.ceil(verdict.waitMs / 1000));
  chats.set(chatId, verdict.state);
  return 0;
}
/** Something else went to the chat (a photo, a sticker, a voice message): the run of identical texts is over. */
export function repeatBroken(chatId: string) { chats.delete(chatId); }
export const repeatNotice = (seconds: number) => `Одинаковое сообщение. Подожди ${seconds} с.`;
