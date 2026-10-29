import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, View } from 'react-native';
import { Text } from './typography';
import { useTheme } from './theme';

// Native module is present only in builds that include expo-alternate-app-icons.
type IconModule = { supportsAlternateIcons: boolean; setAlternateAppIcon: (name: string | null) => Promise<string | null>; getAppIconName: () => string | null };
function iconModule(): IconModule | null {
  if (Platform.OS === 'web') return null;
  try { return require('expo-alternate-app-icons') as IconModule; } catch { return null; }
}

export const APP_ICONS = [
  { id: null, label: 'Синяя', image: require('../assets/icons/default.png') },
  { id: 'Light', label: 'Светлая', image: require('../assets/icons/light.png') },
  { id: 'Outline', label: 'Контур', image: require('../assets/icons/outline.png') },
  { id: 'Aurora', label: 'Сияние', image: require('../assets/icons/aurora.png') },
] as const;

export function AppIconPicker() {
  const t = useTheme(); const native = iconModule();
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { try { setCurrent(native?.getAppIconName() ?? null); } catch { /* unknown */ } }, []);
  if (!native || !native.supportsAlternateIcons) return <Text style={{ color: t.muted, fontSize: 12, padding: 14 }}>Смена иконки недоступна на этом устройстве.</Text>;
  const choose = async (id: string | null) => {
    if (id === current || busy !== undefined) return;
    setBusy(id); setError('');
    try { await native.setAlternateAppIcon(id); setCurrent(id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сменить иконку.'); }
    finally { setBusy(undefined); }
  };
  return <View style={{ padding: 14, gap: 10 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{APP_ICONS.map(icon => {
      const selected = (current ?? null) === icon.id;
      return <Pressable key={icon.label} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`Иконка «${icon.label}»`} onPress={() => void choose(icon.id)} style={({ pressed }) => ({ alignItems: 'center', gap: 6, opacity: pressed ? .7 : 1 })}>
        <View style={{ padding: 3, borderRadius: 19, borderWidth: 2, borderColor: selected ? t.accent : 'transparent' }}>
          <Image source={icon.image} style={{ width: 58, height: 58, borderRadius: 15 }} />
          {busy === icon.id ? <View style={{ position: 'absolute', inset: 3, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#FFF" /></View> : null}
        </View>
        <Text style={{ color: selected ? t.accent : t.muted, fontSize: 11, fontWeight: selected ? '700' : '500' }}>{icon.label}</Text>
      </Pressable>;
    })}</View>
    <Text style={{ color: t.muted, fontSize: 11, lineHeight: 16 }}>{Platform.OS === 'android' ? 'На Android лаунчер может обновить иконку через несколько секунд, а приложение — перезапуститься.' : 'iOS покажет короткое уведомление о смене иконки.'}</Text>
    {error ? <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}
