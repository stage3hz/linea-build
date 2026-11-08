// «Уведомления и звуки»: the device's own switches (show / sound / vibration / sender name, calls, badge),
// kept in AsyncStorage like chatPreferences. The server knows nothing of them; chat mutes live there (chat_settings).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { DEFAULT_NOTIFICATION_PREFS, mergeNotificationPrefs, parseNotificationPrefs, type NotificationPrefs, type NotificationPrefsPatch } from './model';

const KEY = 'linea.notification-prefs.v1';
let current: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

let loaded: Promise<void> | null = null;
export function loadNotificationPrefs(): Promise<void> {
  if (!loaded) loaded = AsyncStorage.getItem(KEY).then(raw => { current = parseNotificationPrefs(raw); emit(); }).catch(() => {});
  return loaded;
}
/** The current switches; the first call starts reading the saved ones (defaults until then). */
export function getNotificationPrefs(): NotificationPrefs { void loadNotificationPrefs(); return current; }
export function setNotificationPrefs(patch: NotificationPrefsPatch) {
  current = mergeNotificationPrefs(current, patch);
  emit();
  void AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {});
}
/** «Сбросить настройки»: back to the defaults, the record removed. */
export function resetNotificationPrefs() {
  current = DEFAULT_NOTIFICATION_PREFS;
  emit();
  void AsyncStorage.removeItem(KEY).catch(() => {});
}
const subscribe = (listener: () => void) => { listeners.add(listener); void loadNotificationPrefs(); return () => { listeners.delete(listener); }; };
export const useNotificationPrefs = () => useSyncExternalStore(subscribe, getNotificationPrefs, () => DEFAULT_NOTIFICATION_PREFS);
