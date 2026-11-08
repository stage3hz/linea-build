import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Api } from './api';

/**
 * Push notifications: Android through Firebase Cloud Messaging, iPhone straight through Apple (APNs).
 * The server sends only the sender's name and «Новое сообщение» / «Входящий звонок»: message text
 * stays end-to-end encrypted. While the app is open, the WebSocket already delivers everything,
 * so no banner is shown.
 */
export const pushSupported = Platform.OS === 'android' || Platform.OS === 'ios';
const platform: 'android' | 'ios' = Platform.OS === 'ios' ? 'ios' : 'android';

/**
 * What this device managed to do: shown in Settings instead of failing silently.
 *  unsupported — web/desktop; pending — not asked yet; denied — the system permission is off;
 *  unavailable — this build has no push configuration (no Firebase file / no Push entitlement);
 *  server-off — the token is registered but the server has no key for this platform; on — working.
 */
export type PushStatus = 'unsupported' | 'pending' | 'denied' | 'unavailable' | 'server-off' | 'on';
let status: PushStatus = pushSupported ? 'pending' : 'unsupported';
const listeners = new Set<() => void>();
const setStatus = (next: PushStatus) => { if (status === next) return; status = next; for (const fn of listeners) fn(); };
export const getPushStatus = () => status;
export const subscribePushStatus = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePushStatus = () => useSyncExternalStore(subscribePushStatus, getPushStatus, getPushStatus);
/** Short Russian explanation for Settings; empty when everything works or push is not a thing here. */
export function pushStatusText(value: PushStatus): string {
  switch (value) {
    case 'denied': return 'Уведомления выключены в настройках системы.';
    case 'unavailable': return 'Уведомления не настроены в этой сборке приложения.';
    case 'server-off': return 'Сервер пока не отправляет уведомления на это устройство.';
    default: return '';
  }
}

if (pushSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: AppState.currentState !== 'active', shouldShowList: AppState.currentState !== 'active', shouldPlaySound: AppState.currentState !== 'active', shouldSetBadge: false }),
  });
}

/** Android notification channels (the server names them in the FCM message); iOS has none. */
async function channels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('messages', { name: 'Сообщения', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 180, 120, 180], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  await Notifications.setNotificationChannelAsync('calls', { name: 'Звонки', importance: Notifications.AndroidImportance.MAX, sound: 'default', vibrationPattern: [0, 600, 400, 600, 400, 600], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC, bypassDnd: false });
}

/** The raw device token as the server expects it: FCM registration token, or the APNs token as lowercase hex. */
function deviceToken(token: Notifications.DevicePushToken): string {
  const data = typeof token.data === 'string' ? token.data : '';
  return platform === 'ios' ? data.replace(/[^0-9a-fA-F]/g, '').toLowerCase() : data;
}

/** Asks for permission once, registers this device's token for the signed-in session and keeps it fresh. */
export function usePush(api: Api, onOpenChat: (chatId: string) => void) {
  const open = useRef(onOpenChat); open.current = onOpenChat;
  useEffect(() => {
    if (!pushSupported) return;
    let alive = true;
    const register = (token: string) => {
      if (!alive || !token) return;
      api.registerPush(token, platform).then(result => { if (alive) setStatus(result.enabled ? 'on' : 'server-off'); }).catch(() => {});
    };
    void (async () => {
      try {
        await channels();
        let { status: granted } = await Notifications.getPermissionsAsync();
        if (granted !== 'granted') granted = (await Notifications.requestPermissionsAsync()).status;
        if (granted !== 'granted') { setStatus('denied'); return; }
        register(deviceToken(await Notifications.getDevicePushTokenAsync()));
      } catch (error) {
        // Android: no Google Play services or no google-services.json in this build.
        // iOS: no «aps-environment» entitlement (sideloaded build) or no network to Apple.
        setStatus('unavailable');
        if (__DEV__) console.warn('push token unavailable', error instanceof Error ? error.message : error);
      }
    })();
    const refreshed = Notifications.addPushTokenListener(token => register(deviceToken(token)));
    const handle = (response: Notifications.NotificationResponse | null) => {
      const chatId = response?.notification.request.content.data?.chatId;
      if (typeof chatId === 'string') open.current(chatId);
    };
    void Notifications.getLastNotificationResponseAsync().then(response => { if (alive) { handle(response); void Notifications.clearLastNotificationResponseAsync?.().catch(() => {}); } }).catch(() => {});
    const tapped = Notifications.addNotificationResponseReceivedListener(handle);
    // Opening the app clears what is already on screen.
    const state = AppState.addEventListener('change', next => { if (next === 'active') void Notifications.dismissAllNotificationsAsync().catch(() => {}); });
    return () => { alive = false; refreshed.remove(); tapped.remove(); state.remove(); };
  }, [api]);
}

/** Called before signing out so this device stops receiving pushes. */
export async function stopPush(api: Api) {
  if (!pushSupported) return;
  await api.unregisterPush().catch(() => {});
  setStatus('pending');
}
