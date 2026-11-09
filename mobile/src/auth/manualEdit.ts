/** A native text-change event cannot identify a one-character paste. This guard
 * rejects insertions of multiple Unicode code points; explicit web clipboard
 * and drop events are blocked separately by ManualField. Deletions and replacing
 * a selection with one code point remain possible.
 *
 * `typed`: key presses seen since the last accepted change. When the app falls behind, iOS delivers
 * several typed characters in one change event («s» → «simt»); each of them came with a key press,
 * so up to `typed` code points may be inserted at once. A paste or autofill comes with no key press
 * and still counts as one at most. */
export function isManualEdit(previous: string, next: string, typed = 1): boolean {
  if (previous === next) return true;
  const before = Array.from(previous), after = Array.from(next);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--; afterEnd--;
  }
  return afterEnd - start <= Math.max(1, Math.floor(typed));
}
