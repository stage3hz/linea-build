// Настройки › Уведомления и звуки (Telegram): the push state of this device, «Личные чаты», «Сообщества»,
// «Звонки», «Бейдж на иконке», the chats whose sound is off, «Сбросить настройки». The switches are kept on
// this device (prefs.ts); a chat's mute is a server setting (chat_settings.muted_until) changed through the API.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Text } from '../typography';
import { Avatar, Button, Icon, Notice, Sheet, SheetAction } from '../components';
import { Group, Item, Toggle } from '../SettingsScreen';
import { useTheme } from '../theme';
import { lightFeedback } from '../haptics';
import { pushStatusText, pushSupported, usePushStatus } from '../push';
import type { Api } from '../api';
import type { Chat } from '../types';
import { RINGTONES, isMuted, mutedStatusText, notificationPrefsChanged } from './model';
import { resetNotificationPrefs, setNotificationPrefs, useNotificationPrefs } from './prefs';
import { MuteSheet } from './MuteSheet';
import { audioPrefs, setAudioPrefs, subscribeAudio } from '../audio/devices';
import { dndLabel, requestWebNotificationPermission, setDesktopPrefs, useDesktopPrefs, webNotificationPermission, type WebPermission } from './desktopNotify';

/** «Не беспокоить» on PC / in the browser: system notifications stay off for this long (ms), forever (null) or come back (0). */
const DND_CHOICES: readonly { id: string; label: string; ms: number | null }[] = [
  { id: '1h', label: 'На 1 час', ms: 3600_000 },
  { id: '8h', label: 'На 8 часов', ms: 8 * 3600_000 },
  { id: 'forever', label: 'До выключения', ms: null },
];

/** The PC / browser part of «Личные чаты» (F11): message text in the notification, «Не беспокоить», the browser's permission. */
function DesktopNotifications({ enabled }: { enabled: boolean }) {
  const t = useTheme(); const desktop = useDesktopPrefs();
  const [dnd, setDnd] = useState(false);
  const [permission, setPermission] = useState<WebPermission>(() => webNotificationPermission());
  const [tick, setTick] = useState(0);
  // «До 18:30» ends by itself: the row re-reads the clock once a minute while a timed DND is on.
  useEffect(() => { if (desktop.dndUntil === null || desktop.dndUntil === Infinity) return; const timer = setInterval(() => setTick(v => v + 1), 60_000); return () => clearInterval(timer); }, [desktop.dndUntil]);
  void tick;
  return <>
    <Toggle label="Текст сообщения в уведомлении" description="Показывать начало сообщения в системном уведомлении на компьютере. Выключено — только имя и «Новое сообщение»; под код-паролем текст не показывается никогда." value={desktop.textPreview} disabled={!enabled} onChange={value => { lightFeedback(); setDesktopPrefs({ textPreview: value }); }} />
    <Item icon="moon" color="#5856D6" label="Не беспокоить" value={dndLabel(desktop)} onPress={() => setDnd(true)} />
    {permission === 'default' ? <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 8 }}>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Браузер ещё не спрашивал разрешения: без него уведомления о новых сообщениях и звонках не покажутся, пока вкладка не на виду.</Text>
      <Button label="Разрешить уведомления в браузере" secondary icon="notifications-outline" onPress={() => { lightFeedback(); void requestWebNotificationPermission().then(setPermission); }} />
    </View> : null}
    {permission === 'denied' ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingBottom: 12 }}>Уведомления для этого сайта запрещены в браузере. Разреши их в настройках сайта (значок замка в адресной строке) и обнови страницу.</Text> : null}
    <Sheet visible={dnd} title="Не беспокоить" onClose={() => setDnd(false)}>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 10 }}>Системные уведомления на этом компьютере не показываются, пока включён режим. Звонки тоже молчат.</Text>
      {DND_CHOICES.map(item => <SheetAction key={item.id} icon={item.ms === null ? 'moon' : 'time-outline'} label={item.label} onPress={() => { lightFeedback(); setDesktopPrefs({ dndUntil: item.ms === null ? Infinity : Date.now() + item.ms }); setDnd(false); }} />)}
      {desktop.dndUntil !== null ? <SheetAction icon="notifications-outline" label="Выключить" description={dndLabel(desktop)} onPress={() => { lightFeedback(); setDesktopPrefs({ dndUntil: null }); setDnd(false); }} /> : null}
    </Sheet>
  </>;
}

export function NotificationsSection({ api, chats, onChatsChanged }: { api: Api; chats: Chat[]; onChatsChanged?: () => void }) {
  const t = useTheme(); const prefs = useNotificationPrefs(); const noiseSuppression = useSyncExternalStore(subscribeAudio, () => audioPrefs().noiseSuppression, () => true); const studioSound = useSyncExternalStore(subscribeAudio, () => audioPrefs().studioSound, () => false); const status = usePushStatus();
  const [sheet, setSheet] = useState<'ringtone' | 'reset' | null>(null);
  const statusText = pushStatusText(status);
  const [muteFor, setMuteFor] = useState<Chat | null>(null);
  const [error, setError] = useState('');
  const muted = chats.filter(chat => isMuted(chat.settings));
  const change = (chat: Chat, body: { muted?: boolean; mutedUntil?: string | null }) => {
    setError(''); lightFeedback();
    api.chatSettings(chat.id, body).then(() => onChatsChanged?.()).catch(e => setError(e instanceof Error ? e.message : 'Не удалось изменить чат.'));
  };
  return <>
    {/* Reviewer item (wave 1): the device's push state is said out loud, not hidden behind a working-looking switch. */}
    {statusText ? <Notice text={statusText} /> : pushSupported ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 6 }}>{status === 'on' ? 'Когда приложение закрыто, уведомления показывает система. Переключатели ниже действуют, пока приложение запущено. В уведомлении только имя отправителя: текст остаётся зашифрованным.' : 'Разрешение на уведомления ещё не запрошено.'}</Text> : <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 6 }}>На компьютере уведомления показываются, пока приложение открыто.</Text>}
    <Group label="Личные чаты">
      <Toggle label="Показывать уведомления" description={pushSupported ? 'Новые сообщения и реакции в личных чатах, пока приложение свёрнуто. Когда оно закрыто, уведомления показывает система.' : 'Новые сообщения и реакции в личных чатах.'} value={prefs.chats.show} onChange={value => setNotificationPrefs({ chats: { show: value } })} />
      <Toggle label="Звук" description="Короткий сигнал при новом сообщении." value={prefs.chats.sound} disabled={!prefs.chats.show} onChange={value => setNotificationPrefs({ chats: { sound: value } })} />
      {/* Reviewer item (wave 2): no switch without a consumer. The phone's vibration follows the system channel, so there is no
          row for it; «Имя отправителя» is read by the PC / browser notifier (desktopNotify) — a phone push always names the sender. */}
      {!pushSupported ? <Toggle label="Имя отправителя" description="Текст сообщений никогда не попадает в уведомление — в нём только имя. Выключи, чтобы видеть лишь «Новое сообщение»." value={prefs.chats.preview} disabled={!prefs.chats.show} onChange={value => setNotificationPrefs({ chats: { preview: value } })} /> : null}
      {Platform.OS === 'web' ? <DesktopNotifications enabled={prefs.chats.show} /> : null}
    </Group>
    <Group label="Сообщества">
      <Toggle label="Показывать уведомления" description="Сообщения в каналах сообществ, где ты состоишь. Сообщества без звука присылают только упоминания." value={prefs.communities.show} onChange={value => setNotificationPrefs({ communities: { show: value } })} />
      <Toggle label="Звук" description="Короткий сигнал при новом сообщении в сообществе." value={prefs.communities.sound} disabled={!prefs.communities.show} onChange={value => setNotificationPrefs({ communities: { sound: value } })} />
    </Group>
    <Group label="Звонки">
      <Item icon="musical-notes" color="#34C759" label="Мелодия" value={RINGTONES.find(item => item.id === prefs.calls.ringtone)?.label} onPress={() => setSheet('ringtone')} />
      <Toggle label="Вибрация" description="Телефон вибрирует при входящем звонке, пока приложение запущено." value={prefs.calls.vibration} onChange={value => setNotificationPrefs({ calls: { vibration: value } })} />
      {/* Telegram's «Шумоподавление» in call settings: the same switch as Звук и микрофон on the PC; a live call picks it up at once. */}
      <Toggle label="Шумоподавление" description="Убирает фоновый шум в звонках: улицу, вентилятор, клавиатуру. Меняется сразу, даже во время разговора." value={noiseSuppression} onChange={value => { lightFeedback(); setAudioPrefs({ noiseSuppression: value }); }} />
      {/* Test preset (studioSound.ts): Web Audio EQ on the PC; the phone WebRTC build has no JS hook for it yet. */}
      <Toggle label="Студийный звук (тест)" description={Platform.OS === 'web' ? 'Эквалайзер для твоего микрофона: плотнее низ, меньше «коробки», ярче голос. Слышат собеседники; включается сразу.' : 'Эквалайзер для твоего микрофона — пока только на компьютере.'} value={Platform.OS === 'web' && studioSound} disabled={Platform.OS !== 'web'} onChange={value => { lightFeedback(); setAudioPrefs({ studioSound: value }); }} />
    </Group>
    <Group label="Бейдж на иконке">
      <Toggle label="Считать непрочитанные" description="Число непрочитанных сообщений на иконке приложения." value={prefs.badge.enabled} onChange={value => setNotificationPrefs({ badge: { enabled: value } })} />
      <Toggle label="Включая чаты без звука" description="Сообщения из чатов с выключенным звуком тоже попадают в число на иконке." value={prefs.badge.countMuted} disabled={!prefs.badge.enabled} onChange={value => setNotificationPrefs({ badge: { countMuted: value } })} />
    </Group>
    {muted.length ? <Group label="Чаты без звука">
      {muted.map(chat => <View key={chat.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingLeft: 14, paddingRight: 6 }}>
        <Avatar user={chat.peer} api={api} size={36} />
        <Pressable accessibilityRole="button" accessibilityLabel={`${chat.peer.displayName}: изменить время без звука`} onPress={() => setMuteFor(chat)} style={{ flex: 1, gap: 2 }}>
          <Text raw numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{chat.peer.displayName}</Text>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{mutedStatusText(chat.settings)}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Включить звук" hitSlop={6} onPress={() => change(chat, { muted: false })} style={{ padding: 10 }}><Icon name="notifications-outline" size={20} color={t.accent} /></Pressable>
      </View>)}
    </Group> : null}
    {error ? <Notice text={error} error /> : null}
    <Group><Item icon="refresh" color="#D9534F" label="Сбросить настройки" danger onPress={() => setSheet('reset')} /></Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 8 }}>Переключатели хранятся только на этом устройстве. Выключенный звук чата действует на всех твоих устройствах: сервер просто не отправляет уведомление, пока он выключен.</Text>
    <Sheet visible={sheet === 'ringtone'} title="Мелодия звонка" onClose={() => setSheet(null)}>
      {RINGTONES.map(item => <SheetAction key={item.id} icon={prefs.calls.ringtone === item.id ? 'checkmark-circle' : 'ellipse-outline'} label={item.label} selected={prefs.calls.ringtone === item.id} onPress={() => { lightFeedback(); setNotificationPrefs({ calls: { ringtone: item.id } }); setSheet(null); }} />)}
    </Sheet>
    <Sheet visible={sheet === 'reset'} title="Сбросить настройки уведомлений?" onClose={() => setSheet(null)}>
      <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 14 }}>{notificationPrefsChanged(prefs) ? 'Все переключатели на этом устройстве вернутся к значениям по умолчанию. Звук в чатах останется как есть.' : 'Все переключатели уже стоят по умолчанию.'}</Text>
      <Button label="Сбросить" danger disabled={!notificationPrefsChanged(prefs)} onPress={() => { lightFeedback(); resetNotificationPrefs(); setSheet(null); }} />
    </Sheet>
    <MuteSheet visible={!!muteFor} title={muteFor?.peer.displayName || ''} current={muteFor?.settings} onClose={() => setMuteFor(null)} onMute={until => { const chat = muteFor; setMuteFor(null); if (chat) change(chat, until === null ? { muted: true } : { mutedUntil: until }); }} onUnmute={() => { const chat = muteFor; setMuteFor(null); if (chat) change(chat, { muted: false }); }} />
  </>;
}
