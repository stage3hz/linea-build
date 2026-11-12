// The same message over and over (anti-spam), for the places where the server reads the text (communities).
// The rule is the app's (mobile/src/repeatGuard.ts):
//  - the same text REPEAT_FREE (5) times in a row; every further copy waits REPEAT_WAIT_MS (10 s) after the
//    previous one and REPEAT_STEP_MS (5 s) longer each time;
//  - once that limit was reached the sender is «strict» there: any next text goes once, its second copy already
//    waits, and the wait keeps growing from where it stopped;
//  - REPEAT_RESET_MS (4 hours) after the limit was first reached (the first held copy), everything is back to the
//    start — whatever was sent in between.
// Kept in memory: a restart forgets it.
export const REPEAT_FREE = 5;
export const REPEAT_WAIT_MS = 10_000;
export const REPEAT_STEP_MS = 5_000;
export const REPEAT_RESET_MS = 4 * 60 * 60_000;
const MAX_KEYS = 50_000;

export const repeatKey = text => String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function createRepeatGuard(now = () => Date.now()) {
  const seen = new Map();
  const put = (id, state) => { seen.delete(id); seen.set(id, state); if (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value); };
  return {
    /** 0 when `text` may be sent to `where` by `who` (and it is counted), else the milliseconds still to wait. */
    wait(who, where, text) {
      const id = `${who}:${where}`, key = repeatKey(text), time = now(), state = seen.get(id);
      const expired = !state || time - (state.level > 0 ? state.heldAt : state.lastAt) >= REPEAT_RESET_MS;
      const level = expired ? 0 : state.level, heldAt = expired ? 0 : state.heldAt;
      // Another text, or a file without one: the run is over; strictness, once earned, stays for its four hours.
      if (!key || expired || state.key !== key) {
        if (!key && level === 0) seen.delete(id); else put(id, { key, count: key ? 1 : 0, lastAt: time, level, heldAt });
        return 0;
      }
      if (state.count < (level > 0 ? 1 : REPEAT_FREE)) { state.count += 1; state.lastAt = time; return 0; }
      const need = REPEAT_WAIT_MS + REPEAT_STEP_MS * level, waited = time - state.lastAt;
      if (waited < need) return need - waited;
      state.count += 1; state.lastAt = time; state.level = level + 1; if (level === 0) state.heldAt = time;
      return 0;
    },
  };
}
