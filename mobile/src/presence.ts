import type { Presence } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
const minutesWord = (n: number) => n % 10 === 1 && n % 100 !== 11 ? 'минуту' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'минуты' : 'минут';
const hoursWord = (n: number) => n % 10 === 1 && n % 100 !== 11 ? 'час' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'часа' : 'часов';

/** Telegram's wording: «в сети», «был(а) 5 минут назад», «был(а) вчера в 21:04», «был(а) недавно». */
export function presenceText(presence: Presence | undefined, now = Date.now()): string | null {
  if (!presence) return null;
  if (presence.online) return 'в сети';
  if (presence.hidden || !presence.lastSeenAt) return 'был(а) недавно';
  const seen = new Date(presence.lastSeenAt), diff = now - seen.getTime();
  if (!Number.isFinite(diff)) return 'был(а) недавно';
  if (diff < 60_000) return 'был(а) только что';
  if (diff < 3_600_000) { const m = Math.floor(diff / 60_000); return `был(а) ${m} ${minutesWord(m)} назад`; }
  const time = `${pad(seen.getHours())}:${pad(seen.getMinutes())}`;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if (seen.getTime() >= today.getTime()) { const h = Math.floor(diff / 3_600_000); return h < 3 ? `был(а) ${h} ${hoursWord(h)} назад` : `был(а) сегодня в ${time}`; }
  if (seen.getTime() >= today.getTime() - 86_400_000) return `был(а) вчера в ${time}`;
  return `был(а) ${pad(seen.getDate())}.${pad(seen.getMonth() + 1)}.${String(seen.getFullYear()).slice(2)}`;
}
