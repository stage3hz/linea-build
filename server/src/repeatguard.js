// The same message over and over (anti-spam), for the places where the server reads the text (communities).
// The rule is the app's (mobile/src/repeatGuard.ts): the same text REPEAT_FREE times in a row, then each further
// copy waits REPEAT_WAIT_MS after the previous one and REPEAT_STEP_MS longer every time; another message, or
// REPEAT_FORGET_MS without that text, starts the count again. Kept in memory: a restart forgets it.
export const REPEAT_FREE = 5;
export const REPEAT_WAIT_MS = 10_000;
export const REPEAT_STEP_MS = 5_000;
export const REPEAT_FORGET_MS = 10 * 60_000;
const MAX_KEYS = 50_000;

export const repeatKey = text => String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function createRepeatGuard(now = () => Date.now()) {
  const seen = new Map();
  return {
    /** 0 when `text` may be sent to `where` by `who` (and it is counted), else the milliseconds still to wait. */
    wait(who, where, text) {
      const id = `${who}:${where}`, key = repeatKey(text), time = now(), state = seen.get(id);
      const fresh = () => { seen.delete(id); seen.set(id, { key, count: 1, lastAt: time }); if (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value); return 0; };
      if (!key) { seen.delete(id); return 0; } // a file without text ends the run
      if (!state || state.key !== key || time - state.lastAt >= REPEAT_FORGET_MS) return fresh();
      if (state.count >= REPEAT_FREE) {
        const need = REPEAT_WAIT_MS + REPEAT_STEP_MS * (state.count - REPEAT_FREE), waited = time - state.lastAt;
        if (waited < need) return need - waited;
      }
      state.count += 1; state.lastAt = time;
      return 0;
    },
  };
}
