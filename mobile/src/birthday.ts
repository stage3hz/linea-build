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

/** Is it this person's birthday today (on this device's calendar)? 29 Feb is celebrated on 28 Feb in other years. */
export function isBirthdayToday(value: string | null | undefined, now = new Date()): boolean {
  const b = parseBirthday(value); if (!b) return false;
  const day = b.month === 2 && b.day === 29 && daysInMonth(2, now.getFullYear()) === 28 ? 28 : b.day;
  return now.getMonth() + 1 === b.month && now.getDate() === day;
}

/** The next local date (midnight) of this birthday, today included. */
export function nextBirthday(value: string | null | undefined, now = new Date()): Date | null {
  const b = parseBirthday(value); if (!b) return null;
  const at = (year: number) => new Date(year, b.month - 1, b.month === 2 && b.day === 29 && daysInMonth(2, year) === 28 ? 28 : b.day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisYear = at(now.getFullYear());
  return thisYear >= today ? thisYear : at(now.getFullYear() + 1);
}

export type BirthdayReminder = { at: Date; title: string; body: string; when: 'tomorrow' | 'today' };

/**
 * Reminders, like the user asked: the day before at 10:00 and 20:00 («Иван: завтра день рождения»),
 * on the day at 00:00 and 10:00 («Иван: сегодня день рождения!»). Only future moments.
 */
export function birthdayReminders(name: string, value: string | null | undefined, now = new Date()): BirthdayReminder[] {
  const day = nextBirthday(value, now); if (!day) return [];
  const at = (offsetDays: number, hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + offsetDays, hour, 0, 0, 0);
  // The name is not declined (an app cannot decline arbitrary names), so it stands in the nominative.
  const tomorrow = { title: `🎂 ${name}: завтра день рождения`, body: 'Нажми, чтобы открыть профиль.', when: 'tomorrow' as const };
  const today = { title: `🎉 ${name}: сегодня день рождения!`, body: 'Нажми, чтобы открыть профиль и поздравить.', when: 'today' as const };
  return [{ at: at(-1, 10), ...tomorrow }, { at: at(-1, 20), ...tomorrow }, { at: at(0, 0), ...today }, { at: at(0, 10), ...today }].filter(item => item.at.getTime() > now.getTime());
}
