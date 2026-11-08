// F2 «Уведомления и звуки»: the pure model — when a mute ends, how its end reads («до 18:30»,
// «до завтра, 09:15», «навсегда») and the local notification preferences. No platform imports: tested in Node.
import { plural } from '../plural';

/** Telegram's sheet: «На 1 час / На 8 часов / На 2 дня / Навсегда» (ms is null for forever). */
export type MuteChoice = '1h' | '8h' | '2d' | 'forever';
export const MUTE_CHOICES: readonly { id: MuteChoice; label: string; ms: number | null }[] = [
  { id: '1h', label: 'На 1 час', ms: 3600_000 },
  { id: '8h', label: 'На 8 часов', ms: 8 * 3600_000 },
  { id: '2d', label: 'На 2 дня', ms: 2 * 86_400_000 },
  { id: 'forever', label: 'Навсегда', ms: null },
];
/** The server accepts at most a year (social.js MAX_MUTE_MS); the custom picker stops a day short of it. */
export const MAX_CUSTOM_DAYS = 365;

/** The mute's end as the server takes it (ISO), or null for «Навсегда». */
export function muteUntil(choice: MuteChoice, now = Date.now()): string | null {
  const option = MUTE_CHOICES.find(item => item.id === choice);
  return option?.ms ? new Date(now + option.ms).toISOString() : null;
}

export type CustomDuration = { days: number; hours: number; minutes: number };
export const customMs = ({ days, hours, minutes }: CustomDuration) => Math.max(0, Math.round(days)) * 86_400_000 + Math.max(0, Math.round(hours)) * 3600_000 + Math.max(0, Math.round(minutes)) * 60_000;
/** «Настроить…»: the end for a hand-picked duration; null when nothing was picked (zero) or it is longer than a year. */
export function customMuteUntil(duration: CustomDuration, now = Date.now()): string | null {
  const ms = customMs(duration);
  if (ms <= 0 || ms > MAX_CUSTOM_DAYS * 86_400_000) return null;
  return new Date(now + ms).toISOString();
}
/** «2 дня 3 часа», «45 минут» — what the custom picker says it will do. */
export function durationLabel(duration: CustomDuration): string {
  const parts: string[] = [];
  const days = Math.max(0, Math.round(duration.days)), hours = Math.max(0, Math.round(duration.hours)), minutes = Math.max(0, Math.round(duration.minutes));
  if (days) parts.push(`${days} ${plural(days, ['день', 'дня', 'дней'])}`);
  if (hours) parts.push(`${hours} ${plural(hours, ['час', 'часа', 'часов'])}`);
  if (minutes) parts.push(`${minutes} ${plural(minutes, ['минута', 'минуты', 'минут'])}`);
  return parts.join(' ');
}

type MuteState = { muted?: boolean; mutedUntil?: string | null } | null | undefined;
/** True while the sound is off: forever, or until a moment the clock has not reached. An expired mute is over
 *  even before the list is refreshed (the server compares the same way). */
export function isMuted(settings: MuteState, now = Date.now()): boolean {
  if (!settings?.muted) return false;
  if (!settings.mutedUntil) return true;
  const at = Date.parse(settings.mutedUntil);
  return !Number.isFinite(at) || at > now;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const two = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** «18:30», «завтра, 09:15», «12 марта, 09:15», «3 января 2027, 09:15» (local time). */
export function muteEndLabel(until: string, now = Date.now()): string {
  const end = new Date(until), today = new Date(now);
  if (!Number.isFinite(end.getTime())) return '';
  const time = `${two(end.getHours())}:${two(end.getMinutes())}`;
  if (sameDay(end, today)) return time;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (sameDay(end, tomorrow)) return `завтра, ${time}`;
  const year = end.getFullYear() === today.getFullYear() ? '' : ` ${end.getFullYear()}`;
  return `${end.getDate()} ${MONTHS[end.getMonth()]}${year}, ${time}`;
}
/** «до 18:30», «до завтра, 09:15», «навсегда». */
export function muteUntilLabel(until: string | null | undefined, now = Date.now()): string {
  if (!until) return 'навсегда';
  const end = muteEndLabel(until, now);
  return end ? `до ${end}` : 'навсегда';
}
/** The chat list line under a muted chat: «Звук выключен до 18:30», «Звук выключен» (forever); empty when the sound is on. */
export function mutedStatusText(settings: MuteState, now = Date.now()): string {
  if (!isMuted(settings, now)) return '';
  return settings?.mutedUntil ? `Звук выключен ${muteUntilLabel(settings.mutedUntil, now)}` : 'Звук выключен';
}

// ---- Local preferences (this device only, AsyncStorage) -------------------------------------------

export type Ringtone = 'neon' | 'pulse' | 'none';
export const RINGTONES: readonly { id: Ringtone; label: string }[] = [
  { id: 'neon', label: 'Неон' }, { id: 'pulse', label: 'Пульс' }, { id: 'none', label: 'Без мелодии' },
];
export type ChatNotificationPrefs = { show: boolean; sound: boolean; vibration: boolean; preview: boolean };
export type CommunityNotificationPrefs = { show: boolean; sound: boolean; vibration: boolean };
export type NotificationPrefs = {
  /** «Личные чаты»: preview = the sender's name (message text is never in a push). */
  chats: ChatNotificationPrefs;
  communities: CommunityNotificationPrefs;
  calls: { ringtone: Ringtone; vibration: boolean };
  /** «Бейдж на иконке»: show the number; count chats whose sound is off. */
  badge: { enabled: boolean; countMuted: boolean };
};
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = Object.freeze({
  chats: Object.freeze({ show: true, sound: true, vibration: true, preview: true }),
  communities: Object.freeze({ show: true, sound: true, vibration: true }),
  calls: Object.freeze({ ringtone: 'neon' as Ringtone, vibration: true }),
  badge: Object.freeze({ enabled: true, countMuted: false }),
}) as NotificationPrefs;

const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
/** Stored JSON → preferences; anything missing or odd falls back to the default (an old or broken record never breaks the screen). */
export function parseNotificationPrefs(raw: string | null | undefined): NotificationPrefs {
  if (!raw) return DEFAULT_NOTIFICATION_PREFS;
  let value: any;
  try { value = JSON.parse(raw); } catch { return DEFAULT_NOTIFICATION_PREFS; }
  if (!value || typeof value !== 'object') return DEFAULT_NOTIFICATION_PREFS;
  const d = DEFAULT_NOTIFICATION_PREFS;
  return {
    chats: { show: bool(value.chats?.show, d.chats.show), sound: bool(value.chats?.sound, d.chats.sound), vibration: bool(value.chats?.vibration, d.chats.vibration), preview: bool(value.chats?.preview, d.chats.preview) },
    communities: { show: bool(value.communities?.show, d.communities.show), sound: bool(value.communities?.sound, d.communities.sound), vibration: bool(value.communities?.vibration, d.communities.vibration) },
    calls: { ringtone: RINGTONES.some(item => item.id === value.calls?.ringtone) ? value.calls.ringtone : d.calls.ringtone, vibration: bool(value.calls?.vibration, d.calls.vibration) },
    badge: { enabled: bool(value.badge?.enabled, d.badge.enabled), countMuted: bool(value.badge?.countMuted, d.badge.countMuted) },
  };
}
/** A one-level-deep change: `{ chats: { sound: false } }` keeps the other chat switches. */
export type NotificationPrefsPatch = { [K in keyof NotificationPrefs]?: Partial<NotificationPrefs[K]> };
export function mergeNotificationPrefs(current: NotificationPrefs, patch: NotificationPrefsPatch): NotificationPrefs {
  return {
    chats: { ...current.chats, ...(patch.chats || {}) },
    communities: { ...current.communities, ...(patch.communities || {}) },
    calls: { ...current.calls, ...(patch.calls || {}) },
    badge: { ...current.badge, ...(patch.badge || {}) },
  };
}
export const notificationPrefsChanged = (prefs: NotificationPrefs) => JSON.stringify(prefs) !== JSON.stringify(DEFAULT_NOTIFICATION_PREFS);
