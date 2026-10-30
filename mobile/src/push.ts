import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Api } from './api';

/**
 * Push notifications (Android, Firebase Cloud Messaging). The server sends only the sender's
 * name and «Новое сообщение» / «Входящий звонок»: message text stays end-to-end encrypted.
 * While the app is open, the WebSocket already delivers everything, so no banner is shown.
 */
export const pushSupported = Platform.OS === 'android';

if (pushSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: AppState.currentState !== 'active', shouldShowList: AppState.currentState !== 'active', shouldPlaySound: AppState.currentState !== 'active', shouldSetBadge: false }),
  });
}

async function channels() {
  await Notifications.setNotificationChannelAsync('messages', { name: 'Сообщения', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 180, 120, 180], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  await Notifications.setNotificationChannelAsync('calls', { name: 'Звонки', importance: Notifications.AndroidImportance.MAX, sound: 'default', vibrationPattern: [0, 600, 400, 600, 400, 600], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC, bypassDnd: false });
}

/** Asks for permission once, registers this device's token for the signed-in session and keeps it fresh. */
export function usePush(api: Api, onOpenChat: (chatId: string) => void) {
  const open = useRef(onOpenChat); open.current = onOpenChat;
  useEffect(() => {
    if (!pushSupported) return;
    let alive = true;
    const register = (token: string) => { if (alive && token) api.registerPush(token, 'android').catch(() => {}); };
    void (async () => {
      try {
        await channels();
        let { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
        if (status !== 'granted') return;
        const token = await Notifications.getDevicePushTokenAsync();
        register(String(token.data));
      } catch { /* no Google Play services or Firebase not configured in this build */ }
    })();
    const refreshed = Notifications.addPushTokenListener(token => register(String(token.data)));
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
}
