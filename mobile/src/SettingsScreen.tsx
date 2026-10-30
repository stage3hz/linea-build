import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, View } from 'react-native';
import { Text } from './typography';
import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import type { Api, Privacy } from './api';
import { Avatar, Icon, IconButton, Notice, type IconName } from './components';
import { GlassBackdrop, GlassSurface } from './glass';
import { useTheme, formatSize } from './theme';
import { ThemeSettings } from './ThemeSettings';
import { useMotion } from './motion';
import type { AnimationMode } from './motionPolicy';
import { AppIconPicker } from './AppIconPicker';
import { StatusEmoji } from './StatusEmoji';
import { TEXT_SIZES, WALLPAPERS, setChatPreferences, textMetrics, useChatPreferences } from './chatPreferences';
import { LinearGradient } from 'expo-linear-gradient';
import { clearDecryptedAttachmentCache } from './e2ee/attachments';
import { clearPhotoCache } from './photo/pipeline';
import { clearVideoCache } from './media/pipeline';
import type { DarkTheme, ThemeMode, User } from './types';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StackBase, StackScreen } from './stack';
import { WallpaperPicker } from './WallpaperPicker';

type Section = 'root' | 'appearance' | 'privacy' | 'data';
type Props = {
  api: Api; user: User; theme: ThemeMode; darkTheme: DarkTheme;
  onTheme: (mode: ThemeMode) => void; onDarkTheme: (mode: DarkTheme) => void;
  onBack: () => void; onProfile: () => void; onSecurity: () => void; onMusic: () => void; onLogout: () => Promise<void>;
};

/** Settings hub: profile on top, grouped sections below. */
export function SettingsScreen(props: Props) {
  const [section, setSection] = useState<Section>('root');
  const progress = useSharedValue(1);
  const page = (current: Section, onBack: () => void) => {
    const title = current === 'appearance' ? 'Оформление' : current === 'privacy' ? 'Конфиденциальность' : current === 'data' ? 'Данные и память' : 'Настройки';
    return <Page title={title} backLabel={current === 'root' ? 'Назад' : 'К настройкам'} onBack={onBack}>
      {current === 'root' ? <Root {...props} open={setSection} /> : current === 'appearance' ? <Appearance {...props} /> : current === 'privacy' ? <PrivacySection api={props.api} /> : <DataSection />}
    </Page>;
  };
  // Sections slide in over the root list and close with the same swipe to the right as chats.
  return <View style={{ flex: 1 }}>
    <StackBase progress={progress} covered={section !== 'root'}>{page('root', props.onBack)}</StackBase>
    {section !== 'root' ? <StackScreen key={section} progress={progress} onBack={() => setSection('root')}>{back => <View style={{ flex: 1 }}><PageBackdrop />{page(section, back)}</View>}</StackScreen> : null}
  </View>;
}

function PageBackdrop() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={{ position: 'absolute', top: -insets.top, bottom: -insets.bottom, left: 0, right: 0 }}><GlassBackdrop /></View>;
}

function Page({ title, backLabel, onBack, children }: { title: string; backLabel: string; onBack: () => void; children: React.ReactNode }) {
  const t = useTheme();
  return <View style={{ flex: 1 }}>
    <GlassSurface radius={27} style={{ margin: 12, marginBottom: 7 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 60 }}>
      <IconButton name="chevron-back" label={backLabel} onPress={onBack} />
      <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>{title}</Text>
    </GlassSurface>
    <ScrollView contentContainerStyle={{ padding: 14, paddingTop: 6, gap: 16, paddingBottom: 30, width: '100%', maxWidth: 680, alignSelf: 'center' }}>{children}</ScrollView>
  </View>;
}

function Group({ children, label }: { children: React.ReactNode; label?: string }) {
  const t = useTheme();
  return <View style={{ gap: 7 }}>
    {label ? <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 8 }}>{label.toUpperCase()}</Text> : null}
    <GlassSurface radius={22} shadow={false} contentStyle={{ paddingVertical: 4 }}>{children}</GlassSurface>
  </View>;
}

function Item({ icon, color, label, value, onPress, danger = false }: { icon: IconName; color: string; label: string; value?: string; onPress: () => void; danger?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 13, minHeight: 52, paddingHorizontal: 14, opacity: pressed ? .6 : 1 })}>
    <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={18} color="#FFF" /></View>
    <Text style={{ flex: 1, color: danger ? t.danger : t.text, fontSize: 15 }}>{label}</Text>
    {value ? <Text style={{ color: t.muted, fontSize: 13 }}>{value}</Text> : null}
    {!danger ? <Icon name="chevron-forward" size={17} color={t.subtle} /> : null}
  </Pressable>;
}

function Toggle({ label, description, value, onChange, disabled = false, badge }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; badge?: string }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 }}>
    <View style={{ flex: 1, gap: 3 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>{badge ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: t.accentSoft }}><Icon name="lock-closed" size={10} color={t.accent} /><Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{badge}</Text></View> : null}</View><Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{description}</Text></View>
    <Switch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} trackColor={{ false: t.subtle, true: t.accent }} thumbColor="#FFF" />
  </View>;
}

function Root({ api, user, onProfile, onSecurity, onMusic, onLogout, open }: Props & { open: (section: Section) => void }) {
  const t = useTheme(); const preferences = useChatPreferences();
  const version = Constants.expoConfig?.version || '';
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Изменить профиль" onPress={onProfile}>
      <GlassSurface radius={26} contentStyle={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar user={user} api={api} size={62} />
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Text numberOfLines={1} style={{ flexShrink: 1, color: t.text, fontSize: 19, fontWeight: '700' }}>{user.displayName}</Text><StatusEmoji user={user} size={17} /></View>
          <Text style={{ color: t.muted, fontSize: 13 }}>@{user.username}</Text>
        </View>
        <Icon name="chevron-forward" size={18} color={t.subtle} />
      </GlassSurface>
    </Pressable>
    <Group>
      <Item icon="person-circle-outline" color="#5B7CFA" label="Мой профиль" onPress={onProfile} />
      <Item icon="musical-notes-outline" color="#E0598B" label="Музыка" onPress={onMusic} />
    </Group>
    <Group>
      <Item icon="color-palette-outline" color="#2FB3B3" label="Оформление" value={textMetrics(preferences.textSize).label} onPress={() => open('appearance')} />
      <Item icon="lock-closed-outline" color="#8E6CE8" label="Конфиденциальность" onPress={() => open('privacy')} />
      <Item icon="shield-checkmark-outline" color="#4AA35E" label="Безопасность и устройства" onPress={onSecurity} />
      <Item icon="server-outline" color="#E39A3B" label="Данные и память" onPress={() => open('data')} />
    </Group>
    <Group>
      <Item icon="log-out-outline" color="#D9534F" label="Выйти из аккаунта" danger onPress={() => void onLogout()} />
    </Group>
    <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center' }}>Инвиз {version} · переписка защищена сквозным шифрованием</Text>
  </>;
}

function Appearance({ theme, darkTheme, onTheme, onDarkTheme }: Props) {
  const t = useTheme(); const preferences = useChatPreferences(); const metrics = textMetrics(preferences.textSize);
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  return <>
    <Group label="Тема"><View style={{ padding: 14 }}><ThemeSettings mode={theme} darkTheme={darkTheme} onChange={onTheme} onDarkTheme={onDarkTheme} /></View></Group>
    <Group label="Иконка приложения"><AppIconPicker /></Group>
    <Group label="Анимации"><MotionSettings /></Group>
    <Group label="Обои чатов"><Item icon="image" color="#2EA37A" label="Обои чатов" value="Выбрать" onPress={() => setWallpaperOpen(true)} /></Group>
    <WallpaperPicker visible={wallpaperOpen} onClose={() => setWallpaperOpen(false)} />
    <Group label="Углы сообщений"><View style={{ padding: 14, flexDirection: 'row', gap: 7 }}>{([[8, 'Острые'], [14, 'Средние'], [20, 'Круглые']] as const).map(([value, label]) => {
      const selected = preferences.bubbleRadius === value;
      return <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ bubbleRadius: value })} style={{ flex: 1, alignItems: 'center', gap: 8, paddingVertical: 10, borderRadius: 15, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><View style={{ width: 46, height: 22, borderRadius: value, borderBottomRightRadius: Math.min(6, value), backgroundColor: t.bubble }} /><Text style={{ color: selected ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{label}</Text></Pressable>;
    })}</View></Group>
    <Group label="Размер текста в чатах">
      <View style={{ padding: 14, gap: 12 }}>
        <View style={{ alignSelf: 'flex-start', maxWidth: '85%', backgroundColor: t.incoming, borderRadius: 20, borderBottomLeftRadius: 7, paddingHorizontal: 12, paddingVertical: 9 }}><Text style={{ color: t.text, fontSize: metrics.fontSize, lineHeight: metrics.lineHeight }}>Привет! Так будет выглядеть текст сообщений.</Text></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{TEXT_SIZES.map(size => {
          const selected = size.id === preferences.textSize;
          return <Pressable key={size.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ textSize: size.id })} style={{ paddingHorizontal: 13, paddingVertical: 9, borderRadius: 15, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 13, fontWeight: '600' }}>{size.label}</Text></Pressable>;
        })}</View>
      </View>
    </Group>
  </>;
}

function PrivacySection({ api }: { api: Api }) {
  const t = useTheme(); const preferences = useChatPreferences();
  const [privacy, setPrivacy] = useState<Privacy | null>(null); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [platina, setPlatina] = useState(false);
  const load = useCallback(() => { setError(''); api.privacy().then(result => { setPrivacy(result.privacy); setPlatina(result.platina === true); }).catch(e => setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки.')); }, [api]);
  useEffect(load, [load]);
  const change = async (patch: Partial<Privacy>) => {
    if (!privacy || saving) return;
    const previous = privacy; setPrivacy({ ...privacy, ...patch }); setSaving(true); setError('');
    try { const result = await api.updatePrivacy(patch); setPrivacy(result.privacy); setPlatina(result.platina === true); }
    catch (e) { setPrivacy(previous); setError(e instanceof Error ? e.message : 'Не удалось сохранить.'); }
    finally { setSaving(false); }
  };
  return <>
    {error ? <Notice text={error} error onRetry={privacy ? undefined : load} /> : null}
    <Group label="На сервере">
      {!privacy ? <ActivityIndicator color={t.accent} style={{ padding: 20 }} /> : <>
        <Toggle label="Новые разговоры" description="Кто ещё не писал тебе, сможет начать чат. Выключи, чтобы писали только те, с кем переписка уже есть." value={privacy.allowNewChats} disabled={saving} onChange={value => void change({ allowNewChats: value })} />
        <Toggle label="Фото профиля для других" description="Если выключить, собеседники и поиск увидят цветной аватар вместо фото." value={privacy.showAvatar} disabled={saving} onChange={value => void change({ showAvatar: value })} />
        <Toggle label="Время захода и «в сети»" badge={platina ? undefined : 'Platina'} description={platina ? 'Взаимно: если скрыть, ты тоже не увидишь, когда собеседник был в сети.' : 'Скрывать время захода можно с Platina.'} value={privacy.showLastSeen !== false} disabled={saving || !platina} onChange={value => void change({ showLastSeen: value })} />
        <Toggle label="Отчёты о прочтении" badge={platina ? undefined : 'Platina'} description={platina ? 'Взаимно: если выключить, ты тоже не увидишь, прочитали ли твои сообщения.' : 'Скрывать прочтение можно с Platina.'} value={privacy.readReceipts} disabled={saving || !platina} onChange={value => void change({ readReceipts: value })} />
      </>}
    </Group>
    <Group label="На этом устройстве">
      <Toggle label="Показывать «печатает…»" description="Собеседник видит, что ты набираешь сообщение." value={preferences.sendTyping} onChange={value => setChatPreferences({ sendTyping: value })} />
    </Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 6 }}>Содержимое сообщений, ответы, реакции, правки и закрепления шифруются на устройстве. Сервер видит только служебные данные: кто, кому и когда.</Text>
  </>;
}

async function directorySize(uri: string, depth = 0): Promise<number> {
  if (depth > 5) return 0;
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return 0;
  if (!info.isDirectory) return info.size || 0;
  let total = 0;
  for (const name of await FileSystem.readDirectoryAsync(uri)) total += await directorySize(`${uri.replace(/\/?$/, '/')}${name}`, depth + 1).catch(() => 0);
  return total;
}

function DataSection() {
  const t = useTheme(); const [size, setSize] = useState<number | null>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState('');
  const measure = useCallback(() => { setSize(null); const dir = FileSystem.cacheDirectory; if (!dir) { setSize(0); return; } directorySize(dir).then(setSize).catch(() => setSize(0)); }, []);
  useEffect(measure, [measure]);
  const clear = async () => {
    setBusy(true); setDone('');
    try {
      await Promise.allSettled([clearDecryptedAttachmentCache(), clearPhotoCache(), clearVideoCache(), Image.clearDiskCache(), Image.clearMemoryCache()]);
      setDone('Кэш очищен. Переписка, ключи шифрования и твои музыкальные файлы не затронуты.');
    } finally { setBusy(false); measure(); }
  };
  return <>
    <Group label="Кэш на этом устройстве">
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="server-outline" size={22} color={t.accent} /><Text style={{ flex: 1, color: t.text, fontSize: 15 }}>Временные файлы</Text>{size === null ? <ActivityIndicator color={t.accent} size="small" /> : <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{formatSize(size)}</Text>}</View>
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Расшифрованные для просмотра вложения, обработанные фото и видео, миниатюры. Всё это можно скачать и расшифровать заново.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void clear()} style={({ pressed }) => ({ minHeight: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accentSoft, borderWidth: 1, borderColor: t.border, opacity: busy ? .5 : pressed ? .7 : 1 })}>{busy ? <ActivityIndicator color={t.accent} /> : <Text style={{ color: t.accent, fontSize: 14, fontWeight: '700' }}>Очистить кэш</Text>}</Pressable>
        {done ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{done}</Text> : null}
      </View>
    </Group>
  </>;
}

function MotionSettings() {
  const t = useTheme(); const preferences = useChatPreferences(); const motion = useMotion();
  const options: { id: AnimationMode; label: string }[] = [{ id: 'auto', label: 'Авто' }, { id: 'on', label: 'Всегда' }, { id: 'off', label: 'Выкл' }];
  return <View style={{ padding: 14, gap: 10 }}>
    <View style={{ flexDirection: 'row', gap: 7 }}>{options.map(option => {
      const selected = preferences.animations === option.id;
      return <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ animations: option.id })} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 15, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 13, fontWeight: '600' }}>{option.label}</Text></Pressable>;
    })}</View>
    {preferences.animations === 'auto' ? <View style={{ gap: 7 }}><Text style={{ color: t.muted, fontSize: 12 }}>Энергосбережение: выключать при заряде</Text><View style={{ flexDirection: 'row', gap: 7 }}>{[0, 0.15, 0.27, 0.4].map(level => {
      const selected = preferences.lowBattery === level;
      return <Pressable key={level} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => setChatPreferences({ lowBattery: level })} style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 13, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{level ? `≤ ${Math.round(level * 100)}%` : 'Никогда'}</Text></Pressable>;
    })}</View></View> : null}
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{motion.reason}</Text>
  </View>;
}
