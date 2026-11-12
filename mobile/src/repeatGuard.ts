// The same message over and over (anti-spam).
//
//  - The same text may be sent to a chat REPEAT_FREE (5) times in a row. Every further copy has to wait:
//    REPEAT_WAIT_MS (10 s) after the previous one, and REPEAT_STEP_MS (5 s) longer with each copy (10, 15, 20 s, …).
//  - Once that limit has been reached the chat is «strict»: the NEXT messages are held too — any text may be sent
//    once, its second copy already waits, and the wait keeps growing from where it stopped (it does not start again
//    at 10 s for a new text).
//  - REPEAT_RESET_MS (4 hours) after the limit was first reached (the first held copy), everything is back to the
//    start — whatever was sent in between.
// «The same»: compared without case, and with runs of spaces and line breaks taken as one space.
//
// Private chats are end-to-end encrypted — the server cannot see what is repeated, so there this rule is kept by
// the app itself (it stops ordinary flooding; a rebuilt app could ignore it). In communities, where the server
// reads the text, the server keeps the same rule too (server/src/repeatguard.js).
export const REPEAT_FREE = 5;
export const REPEAT_WAIT_MS = 10_000;
export const REPEAT_STEP_MS = 5_000;
export const REPEAT_RESET_MS = 4 * 60 * 60_000;

/** `count`: copies of `key` sent in a row, the last at `lastAt`. `level`: held copies sent so far (each adds a step
 *  to the wait), the first of them at `heldAt`; above zero the chat is strict. */
export type RepeatState = { key: string; count: number; lastAt: number; level: number; heldAt: number };
export type RepeatVerdict = { allowed: true; state: RepeatState } | { allowed: false; waitMs: number };

export const repeatKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether `text` may be sent now, given what was sent to this chat before (`state`, null at first). */
export function checkRepeat(state: RepeatState | null | undefined, text: string, now: number): RepeatVerdict {
  const key = repeatKey(text);
  // Four hours after the first held copy the strictness is gone; without any, a run is forgotten after as long.
  const expired = !state || now - (state.level > 0 ? state.heldAt : state.lastAt) >= REPEAT_RESET_MS;
  const level = expired ? 0 : state!.level, heldAt = expired ? 0 : state!.heldAt;
  if (!key || expired || state!.key !== key) return { allowed: true, state: { key, count: key ? 1 : 0, lastAt: now, level, heldAt } };
  if (state!.count < (level > 0 ? 1 : REPEAT_FREE)) return { allowed: true, state: { key, count: state!.count + 1, lastAt: now, level, heldAt } };
  const need = REPEAT_WAIT_MS + REPEAT_STEP_MS * level, waited = now - state!.lastAt;
  return waited >= need ? { allowed: true, state: { key, count: state!.count + 1, lastAt: now, level: level + 1, heldAt: level > 0 ? heldAt : now } } : { allowed: false, waitMs: need - waited };
}

const chats = new Map<string, RepeatState>();
/** The app's own record, per chat, for this run. Returns 0 when the text may be sent (and counts it), else the seconds to wait. */
export function repeatWait(chatId: string, text: string, now = Date.now()): number {
  const verdict = checkRepeat(chats.get(chatId), text, now);
  if (!verdict.allowed) return Math.max(1, Math.ceil(verdict.waitMs / 1000));
  chats.set(chatId, verdict.state);
  return 0;
}
/** Something else went to the chat (a photo, a sticker, a voice message): the run of identical texts is over
 *  (the strictness, once earned, stays for its four hours). */
export function repeatBroken(chatId: string, now = Date.now()) { repeatWait(chatId, '', now); }
export const repeatNotice = (seconds: number) => `Одинаковое сообщение. Подожди ${seconds} с.`;
