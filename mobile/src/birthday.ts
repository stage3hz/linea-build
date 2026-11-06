// Birthday as Telegram shows it: «2 мар» (day and month) or «2 мар 1999» (full date). Stored as
// «MM-DD» or «YYYY-MM-DD».
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export type Birthday = { day: number; month: number; year: number | null };

export function parseBirthday(value: string | null | undefined): Birthday | null {
  const m = value ? /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(value) : null;
  return m ? { year: m[1] ? Number(m[1]) : null, month: Number(m[2]), day: Number(m[3]) } : null;
}

export function formatBirthday(value: string | null | undefined): string {
  const b = parseBirthday(value); if (!b) return '';
  return `${b.day} ${MONTHS_SHORT[b.month - 1]}${b.year ? ` ${b.year}` : ''}`;
}

export function daysInMonth(month: number, year: number | null): number {
  return new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate(); // 2000 is a leap year: 29 Feb allowed without a year
}

export function birthdayValue(b: Birthday): string {
  const mm = String(b.month).padStart(2, '0'), dd = String(b.day).padStart(2, '0');
  return b.year ? `${b.year}-${mm}-${dd}` : `${mm}-${dd}`;
}
