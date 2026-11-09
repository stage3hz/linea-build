/**
 * «Ответить» / «Изменить» on iPhone: the message menu is a Modal still closing when the field is asked
 * to focus, and a field behind a presented Modal cannot take the keyboard — so the focus is asked again
 * a few times. The retries stop for good at the first check that finds the field focused, and when the
 * keyboard goes down after the field had focus: the person closed it, it is not taken back.
 */
export const FOCUS_RETRY_DELAYS = [60, 320, 650] as const;
type Timer = ReturnType<typeof setTimeout>;
export type FocusRetry = { stop: () => void; focused: () => void; keyboardHidden: () => void };
/** Retries in flight, so leaving a screen can stop them all (stopFocusRetries). */
const active = new Set<FocusRetry>();
/**
 * The screen is going away (back button, swipe back): no pending retry may focus its field again —
 * that would raise the keyboard over the screen underneath (the chat list).
 */
export function stopFocusRetries(): void { for (const retry of [...active]) retry.stop(); }
export function retryFocus(field: { isFocused: () => boolean; focus: () => void }, delays: readonly number[] = FOCUS_RETRY_DELAYS, timers: { set: (fn: () => void, ms: number) => Timer; clear: (id: Timer) => void } = { set: setTimeout, clear: clearTimeout }): FocusRetry {
  let done = false, hadFocus = false;
  const ids: Timer[] = [];
  const stop = () => { done = true; ids.forEach(timers.clear); active.delete(handle); };
  const handle: FocusRetry = {
    stop,
    // The field's own focus event: had focus (a later keyboard-down stops the retries); the next check confirms it.
    focused: () => { hadFocus = true; },
    keyboardHidden: () => { if (hadFocus) stop(); },
  };
  active.add(handle);
  for (const delay of delays) ids.push(timers.set(() => {
    if (done) return;
    if (field.isFocused()) { hadFocus = true; stop(); return; }
    field.focus();
  }, delay));
  return handle;
}
