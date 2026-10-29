/** A native text-change event cannot identify a one-character paste. This guard
 * rejects insertions of multiple Unicode code points; explicit web clipboard
 * and drop events are blocked separately by ManualField. Deletions and replacing
 * a selection with one code point remain possible. */
export function isManualEdit(previous: string, next: string): boolean {
  if (previous === next) return true;
  const before = Array.from(previous), after = Array.from(next);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--; afterEnd--;
  }
  return afterEnd - start <= 1;
}
