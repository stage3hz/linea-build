import React from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Text } from './typography';
import { Icon } from './components';
import { useTheme } from './theme';
import type { DarkTheme, ThemeMode } from './types';

export const THEME_NAMES: Record<ThemeMode, string> = { system: 'Как в системе', light: 'Светлая', dark: 'Тёмная', black: 'Чёрная' };
const appearances = [
  { value: 'light', label: 'Светлая', color: '#EDF3FB', line: '#CEDAF0' },
  { value: 'dark', label: 'Тёмная', color: '#080F1E', line: '#31415B' },
  { value: 'black', label: 'Чёрная', color: '#000000', line: '#3C3C3C' },
] as const;

export function ThemeSettings({ mode, darkTheme, onChange, onDarkTheme }: {
  mode: ThemeMode; darkTheme: DarkTheme; onChange: (mode: ThemeMode) => void; onDarkTheme: (mode: DarkTheme) => void;
}) {
  const t = useTheme();
  return <View style={{ gap: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Icon name="phone-portrait-outline" color={t.muted} size={23}/>
      <View style={{ flex: 1, gap: 5 }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Автоматически</Text><Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Следовать светлой или тёмной теме устройства.</Text></View>
      <Switch accessibilityLabel="Автоматически менять тему вместе с системой" value={mode === 'system'} onValueChange={enabled => onChange(enabled ? 'system' : t.black ? 'black' : t.dark ? 'dark' : 'light')} trackColor={{ false: t.surface2, true: t.accent }} thumbColor={mode === 'system' ? t.onAccent : t.muted}/>
    </View>
    <View style={{ flexDirection: 'row', gap: 9 }}>{appearances.map(item => <Pressable key={item.value} onPress={() => onChange(item.value)} accessibilityRole="radio" accessibilityLabel={`${item.label} тема`} accessibilityState={{ selected: mode === item.value }} style={{ flex: 1, minHeight: 110, gap: 10, padding: 10, borderRadius: 20, borderWidth: 1, borderColor: mode === item.value ? t.accent : t.border, backgroundColor: mode === item.value ? t.accentSoft : 'transparent' }}>
      <View style={{ height: 51, borderRadius: 12, backgroundColor: item.color, borderWidth: 1, borderColor: item.line, padding: 8, gap: 5 }}><View style={{ width: '68%', height: 7, borderRadius: 4, backgroundColor: item.line }}/><View style={{ width: '48%', height: 7, borderRadius: 4, backgroundColor: item.line }}/><View style={{ alignSelf: 'flex-end', width: '52%', height: 7, borderRadius: 4, backgroundColor: item.line }}/></View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4 }}><Text style={{ color: mode === item.value ? t.text : t.muted, fontSize: 12, fontWeight: '600' }}>{item.label}</Text>{mode === item.value ? <Icon name="checkmark-circle" color={t.accent} size={15}/> : null}</View>
    </Pressable>)}</View>
    {mode === 'system' ? <View style={{ gap: 9 }}><Text style={{ color: t.muted, fontSize: 12 }}>Когда система переключается на тёмную тему:</Text><View style={{ flexDirection: 'row', gap: 8 }}>{(['dark', 'black'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: darkTheme === value }} onPress={() => onDarkTheme(value)} style={{ flex: 1, minHeight: 44, borderRadius: 15, borderWidth: 1, borderColor: darkTheme === value ? t.accent : t.border, backgroundColor: darkTheme === value ? t.accentSoft : 'transparent', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}><Text style={{ color: darkTheme === value ? t.text : t.muted, fontSize: 12 }}>{THEME_NAMES[value]}</Text>{darkTheme === value ? <Icon name="checkmark" size={15} color={t.accent}/> : null}</Pressable>)}</View></View> : <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Ручной выбор сохраняется после перезапуска и не зависит от темы устройства.</Text>}
  </View>;
}
