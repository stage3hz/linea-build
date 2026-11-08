import { useSyncExternalStore } from 'react';
import type { DeviceSession } from './types';

/**
 * «Новый вход» (F6): the server tells the account's other devices about a new sign-in with a
 * `session.new` socket event. This store keeps the sign-ins not yet acknowledged on this device, so
 * the notice (NewLoginNotice.tsx) can show them on any screen. Nothing is persisted: the list is
 * about what happened while this device was open; the full list lives in Безопасность → Сеансы.
 *
 * Wiring: the socket handler in useMessenger.ts passes the event to `noteSocketEvent(data)`, and
 * App.tsx mounts `<NewLoginNotice api={api}/>` beside RecoveryNotice.
 */
export type SessionDetails = DeviceSession & {
  platform?: string | null; deviceModel?: string | null; osVersion?: string | null; appVersion?: string | null;
  /** The address of the sign-in as the server saw it: text only, never geolocated. */
  ip?: string | null;
};
export type NewLogin = { session: SessionDetails; label: string; receivedAt: number };

let alerts: NewLogin[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const MAX_ALERTS = 5;

const isSession = (value: unknown): value is SessionDetails => !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';

/** One line for the notice: model and OS, else the device name. Mirrors server `sessionLabel`. */
export function loginLabel(session: SessionDetails): string {
  const name = session.deviceModel || session.deviceName || 'Неизвестное устройство';
  return session.osVersion ? `${name} · ${session.osVersion}` : name;
}

/** Feed every socket packet here; only `session.new` is kept. Returns true when a notice was added. */
export function noteSocketEvent(data: unknown, now: () => number = Date.now): boolean {
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'session.new') return false;
  const packet = data as { session?: unknown; label?: unknown };
  if (!isSession(packet.session)) return false;
  const session = packet.session;
  const label = typeof packet.label === 'string' && packet.label.trim() ? packet.label : loginLabel(session);
  alerts = [{ session, label, receivedAt: now() }, ...alerts.filter(alert => alert.session.id !== session.id)].slice(0, MAX_ALERTS);
  emit();
  return true;
}
/** «Это был я» or the session was ended: the notice goes away on this device. */
export function dismissLogin(sessionId: string) {
  const next = alerts.filter(alert => alert.session.id !== sessionId);
  if (next.length === alerts.length) return;
  alerts = next; emit();
}
export function clearLogins() { if (!alerts.length) return; alerts = []; emit(); }
export const getLogins = () => alerts;
export const useNewLogins = () => useSyncExternalStore(subscribe, getLogins, getLogins);
