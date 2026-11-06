// Birthday reminders for your friends (Telegram-like; the server shares birthdays with friends only): local notifications on this device —
// the day before at 10:00 and 20:00, on the day at 00:00 and 10:00. Tapping one opens that chat with
// the person's profile. Nothing is sent to the server: birthdays come with the chats you already have.
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Chat } from './types';
import { birthdayReminders } from './birthday';

/** A chat whose peer profile should open as soon as the chat is shown (from a birthday reminder). */
let profileRequest: string | null = null;
export const takeProfileRequest = (chatId: string) => { if (profileRequest !== chatId) return false; profileRequest = null; return true; };

const MAX = 48; // iOS keeps at most 64 pending local notifications per app

if (Platform.OS === 'ios') {
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: AppState.currentState !== 'active', shouldShowList: true, shouldPlaySound: AppState.currentState !== 'active', shouldSetBadge: false }) });
}

export function useBirthdayReminders(chats: Chat[], onOpenChat: (chatId: string) => void) {
  const open = useRef(onOpenChat); open.current = onOpenChat;
  const signature = chats.filter(chat => chat.peer.birthday && !chat.settings?.archived).map(chat => `${chat.id}:${chat.peer.displayName}:${chat.peer.birthday}`).sort().join('|');
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const handle = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data as { kind?: string; birthdayChatId?: string } | undefined;
      if (data?.kind === 'birthday' && typeof data.birthdayChatId === 'string') { profileRequest = data.birthdayChatId; open.current(data.birthdayChatId); }
    };
    void Notifications.getLastNotificationResponseAsync().then(handle).catch(() => {});
    const tapped = Notifications.addNotificationResponseReceivedListener(handle);
    return () => tapped.remove();
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let alive = true;
    const timer = setTimeout(() => void (async () => {
      try {
        const scheduled = await Notifications.getAllScheduledNotificationsAsync();
        await Promise.all(scheduled.filter(item => (item.content.data as { kind?: string } | undefined)?.kind === 'birthday').map(item => Notifications.cancelScheduledNotificationAsync(item.identifier)));
        const people = chats.filter(chat => chat.peer.birthday && !chat.settings?.archived);
        if (!people.length || !alive) return;
        let { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
        if (status !== 'granted' || !alive) return;
        if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('birthdays', { name: 'Дни рождения', importance: Notifications.AndroidImportance.DEFAULT, sound: 'default' });
        const all = people.flatMap(chat => birthdayReminders(chat.peer.displayName, chat.peer.birthday).map(item => ({ ...item, chatId: chat.id })))
          .sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, MAX);
        for (const item of all) {
          if (!alive) return;
          await Notifications.scheduleNotificationAsync({
            content: { title: item.title, body: item.body, sound: 'default', data: { kind: 'birthday', birthdayChatId: item.chatId } },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.at, ...(Platform.OS === 'android' ? { channelId: 'birthdays' } : {}) },
          });
        }
      } catch { /* notifications unavailable on this device */ }
    })(), 1500);
    return () => { alive = false; clearTimeout(timer); };
  }, [signature]);
}
