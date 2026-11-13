// F4 «Отправить без звука» / «Отправить позже» — the pure part: what a scheduled item is, the
// presets of the picker, the labels of the list, when an item can be retried. No React, no network.
// The server keeps a scheduled message as the same end-to-end encrypted envelopes a normal send uses
// (it never sees the text); the text shown in the list comes from this device's vault.
import type { EncryptedMessage } from '../e2ee/types';
import type { Attachment, Message } from '../types';
import type { MessageMeta } from '../messageMeta';

export type ScheduledStatus = 'scheduled' | 'failed';
/** One row of the server's list (`GET /scheduled`): ciphertext + time, nothing readable. */
export type ScheduledMessage = {
  id: string; chatId: string; clientId: string; deliverAt: string; status: ScheduledStatus;
  /** Why the server could not release it: E2EE_DEVICES_CHANGED (the peer's devices changed — re-encrypt), BLOCKED, CHAT_GONE, … */
  failure: string | null; push: 'message' | 'silent'; createdAt: string; encrypted?: EncryptedMessage;
};
/** The same row with the text opened from the vault of this device (an empty text + `cryptoState` other than decrypted = another device scheduled it). */
export type ScheduledItem = ScheduledMessage & { text: string; attachment: Attachment | null; meta?: MessageMeta; cryptoState?: Message['cryptoState'] };
/** Long-press on Send: without sound (the push arrives quietly, the message is still unread) and/or at a chosen time. */
export type SendOptions = { silent?: boolean; deliverAt?: string };

export const MIN_AHEAD_MS = 60_000;
export const MAX_AHEAD_MS = 365 * 86_400_000;
/** The vault keeps the message under its clientId; the intent «send at …» is kept beside it (per account) so a restart does not send it at once. */
export const scheduledIntentKey = (userId: string) => `linea.scheduled-intent.v1:${userId}`;

const plural = (n: number, one: string, few: string, many: string) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const two = (n: number) => String(n).padStart(2, '0');
export const timeLabel = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}`;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** `day` at hour:minute, local time. */
export function withDayTime(day: Date, hour: number, minute: number): Date {
  const next = new Date(day); next.setHours(hour, minute, 0, 0); return next;
}
/** Telegram-like quick choices: in an hour, tonight (while it is still ahead), tomorrow morning. */
export function schedulePresets(now = new Date()): { label: string; at: Date }[] {
  const presets: { label: string; at: Date }[] = [];
  const inAnHour = new Date(now.getTime() + 3_600_000); inAnHour.setMinutes(Math.ceil(inAnHour.getMinutes() / 5) * 5, 0, 0);
  presets.push({ label: 'Через час', at: inAnHour });
  const tonight = withDayTime(now, 20, 0);
  if (tonight.getTime() - now.getTime() >= 30 * 60_000) presets.push({ label: 'Сегодня в 20:00', at: tonight });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  presets.push({ label: 'Завтра в 09:00', at: withDayTime(tomorrow, 9, 0) });
  if (presets.length < 3) presets.push({ label: 'Завтра в 20:00', at: withDayTime(tomorrow, 20, 0) });
  return presets;
}
/** Null when the time can be scheduled; otherwise the reason shown under the picker. */
export function validateDeliverAt(at: Date, now = new Date()): string | null {
  if (!Number.isFinite(at.getTime())) return 'Выбери дату и время.';
  if (at.getTime() - now.getTime() < MIN_AHEAD_MS) return 'Время уже прошло — выбери хотя бы минуту вперёд.';
  if (at.getTime() - now.getTime() > MAX_AHEAD_MS) return 'Отложить можно не больше чем на год.';
  return null;
}
/** «Сегодня в 20:00», «Завтра в 09:00», «15 ноября в 09:00», «3 января 2027 в 10:00». */
export function formatDeliverAt(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const time = timeLabel(date);
  if (sameDay(date, now)) return `Сегодня в ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (sameDay(date, tomorrow)) return `Завтра в ${time}`;
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} в ${time}`;
}
/** The day shown in the custom picker: «Сегодня», «Завтра» or the date. */
export function dayLabel(day: Date, now = new Date()): string {
  if (sameDay(day, now)) return 'Сегодня';
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (sameDay(day, tomorrow)) return 'Завтра';
  const year = day.getFullYear() === now.getFullYear() ? '' : ` ${day.getFullYear()}`;
  return `${day.getDate()} ${MONTHS[day.getMonth()]}${year}`;
}
export const countScheduled = (n: number) => `${n} ${plural(n, 'отложенное сообщение', 'отложенных сообщения', 'отложенных сообщений')}`;

/** What the list says under an item the server could not release. */
export function failureText(code: string | null | undefined): string {
  switch (code) {
    case 'E2EE_DEVICES_CHANGED': return 'У собеседника изменились устройства. Будет отправлено, когда вы будете в сети.';
    case 'BLOCKED': return 'Переписка с этим пользователем недоступна.';
    case 'CHAT_GONE': return 'Чат удалён.';
    case 'ATTACHMENT_GONE': case 'ATTACHMENT_USED': return 'Вложение больше недоступно.';
    case 'CLIENT_ID_USED': return 'Это сообщение уже отправлено.';
    default: return 'Не удалось отправить.';
  }
}
/** Only a device-set failure is retried by itself: this device re-encrypts the text it still holds and sends through the normal route. */
export const canResend = (item: Pick<ScheduledItem, 'status' | 'failure' | 'cryptoState'>) => item.status === 'failed' && item.failure === 'E2EE_DEVICES_CHANGED' && item.cryptoState === 'decrypted';

/** The push the server should send for a message with this meta: a ringing call, nothing for an action, quiet for «без звука». */
export function pushKind(meta: MessageMeta | undefined): 'call' | 'missed' | 'none' | 'silent' | undefined {
  const action = meta?.action;
  // The caller's «not answered» ends the call with a notification of its own: the ringing one lives 45 seconds and
  // may never reach a phone that was asleep on a mobile network.
  if (action?.type === 'call' && action.step === 'end' && action.reason === 'missed' && action.caller === true) return 'missed';
  if (action) return action.type === 'call' && action.step === 'offer' ? 'call' : 'none';
  return meta?.silent ? 'silent' : undefined;
}
/** The meta a message goes out with after the long-press menu: `silent: true` rides inside the ciphertext for the UI. */
export function withSendOptions(meta: MessageMeta | undefined, options: SendOptions | undefined): MessageMeta | undefined {
  if (!options?.silent || meta?.action) return meta;
  return { ...(meta || {}), silent: true };
}
