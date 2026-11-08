/**
 * Russian plural forms: plural(1,['чат','чата','чатов']) → «чат», 2–4 → «чата», 5–20 → «чатов»,
 * and the same by the last digit for 21+, except 11–14 («21 чат», «22 чата», «111 чатов»).
 */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(Math.trunc(n)), last = abs % 10, tens = abs % 100;
  if (last === 1 && tens !== 11) return forms[0];
  if (last >= 2 && last <= 4 && (tens < 10 || tens >= 20)) return forms[1];
  return forms[2];
}
export const CHATS = ['чат', 'чата', 'чатов'] as const;
/** «21 чат», «22 чата», «25 чатов». */
export const countChats = (n: number) => `${n} ${plural(n, CHATS)}`;
