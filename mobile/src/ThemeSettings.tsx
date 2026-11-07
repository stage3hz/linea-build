import React, { useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { PALETTES, paletteThemes } from './themes/palettes';
import { Text } from './typography';
import { Icon } from './components';
import { useTheme } from './theme';
import type { DarkTheme, ThemeMode } from './types';

export const THEME_NAMES = { system: 'Как в системе', light: 'Светлая', dark: 'Тёмная', black: 'Чёрная', graphite: 'Графит', ...Object.fromEntries(PALETTES.map(p => [p.id, p.name])) } as Record<ThemeMode, string>;

/** A small chat preview in the theme's own colours. */
function PaletteCard({ id, selected, locked, onPress }: { id: (typeof PALETTES)[number]['id']; selected: boolean; locked: boolean; onPress: () => void }) {
  const t = useTheme(), p = paletteThemes[id];
  return <Pressable onPress={onPress} accessibilityRole="radio" accessibilityLabel={`Тема ${THEME_NAMES[id]}${locked ? ', доступна с Platina' : ''}`} accessibilityState={{ selected, disabled: locked }} style={{ width: 118, gap: 8, padding: 8, borderRadius: 20, borderWidth: 1.5, borderColor: selected ? t.accent : t.border, backgroundColor: selected ? t.accentSoft : 'transparent' }}>
    <View style={{ height: 92, borderRadius: 14, backgroundColor: p.bg, padding: 8, gap: 6, overflow: 'hidden' }}>
      <View style={{ alignSelf: 'flex-start', width: '62%', height: 16, borderRadius: 8, borderBottomLeftRadius: 3, backgroundColor: p.incoming }} />
      <View style={{ alignSelf: 'flex-end', width: '70%', height: 16, borderRadius: 8, borderBottomRightRadius: 3, backgroundColor: p.bubble }} />
      <View style={{ alignSelf: 'flex-start', width: '45%', height: 16, borderRadius: 8, borderBottomLeftRadius: 3, backgroundColor: p.incoming }} />
      <View style={{ position: 'absolute', right: 8, bottom: 8, width: 22, height: 22, borderRadius: 11, backgroundColor: p.accent }} />
      {locked ? <View style={{ position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)' }}><Icon name="lock-closed" size={10} color="#E8ECF4" /><Text style={{ color: '#E8ECF4', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 }}>PLATINA</Text></View> : null}
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4 }}><Text style={{ color: selected ? t.text : t.muted, fontSize: 12, fontWeight: '600' }}>{THEME_NAMES[id]}</Text>{selected ? <Icon name="checkmark-circle" color={t.accent} size={14} /> : null}</View>
  </Pressable>;
}
const appearances = [
  { value: 'light', label: 'Светлая', color: '#EDF3FB', line: '#CEDAF0' },
  { value: 'dark', label: 'Тёмная', color: '#080F1E', line: '#31415B' },
  { value: 'black', label: 'Чёрная', color: '#08090A', line: '#23252A' },
  { value: 'graphite', label: 'Графит', color: '#1C1C1E', line: '#3A3A3C' },
] as const;

/**
 * `platina` unlocks the colour palettes. Without it the cards stay visible with a
 * lock; a tap opens the Platina showcase (`onLocked`) or, for guests, explains why.
 */
export function ThemeSettings({ mode, darkTheme, onChange, onDarkTheme, platina = false, onLocked }: {
  mode: ThemeMode; darkTheme: DarkTheme; onChange: (mode: ThemeMode) => void; onDarkTheme: (mode: DarkTheme) => void;
  platina?: boolean; onLocked?: () => void;
}) {
  const t = useTheme();
  const [lockedHint, setLockedHint] = useState(false);
  const pick = (id: (typeof PALETTES)[number]['id']) => {
    if (!platina) { if (onLocked) onLocked(); else setLockedHint(true); return; }
    if (mode === 'system') onDarkTheme(id); else onChange(id);
  };
  return <View style={{ gap: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Icon name="phone-portrait-outline" color={t.muted} size={23}/>
      <View style={{ flex: 1, gap: 5 }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Автоматически</Text><Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Следовать светлой или тёмной теме устройства.</Text></View>
      <Switch accessibilityLabel="Автоматически менять тему вместе с системой" value={mode === 'system'} onValueChange={enabled => onChange(enabled ? 'system' : (PALETTES.some(p => p.id === darkTheme) || darkTheme === 'graphite') && t.dark ? darkTheme : t.black ? 'black' : t.dark ? 'dark' : 'light')} trackColor={{ false: t.surface2, true: t.accent }} thumbColor={mode === 'system' ? t.onAccent : t.muted}/>
    </View>
    <View style={{ flexDirection: 'row', gap: 9 }}>{appearances.map(item => <Pressable key={item.value} onPress={() => onChange(item.value)} accessibilityRole="radio" accessibilityLabel={`${item.label} тема`} accessibilityState={{ selected: mode === item.value }} style={{ flex: 1, minHeight: 110, gap: 10, padding: 10, borderRadius: 20, borderWidth: 1, borderColor: mode === item.value ? t.accent : t.border, backgroundColor: mode === item.value ? t.accentSoft : 'transparent' }}>
      <View style={{ height: 51, borderRadius: 12, backgroundColor: item.color, borderWidth: 1, borderColor: item.line, padding: 8, gap: 5 }}><View style={{ width: '68%', height: 7, borderRadius: 4, backgroundColor: item.line }}/><View style={{ width: '48%', height: 7, borderRadius: 4, backgroundColor: item.line }}/><View style={{ alignSelf: 'flex-end', width: '52%', height: 7, borderRadius: 4, backgroundColor: item.line }}/></View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4 }}><Text style={{ color: mode === item.value ? t.text : t.muted, fontSize: 12, fontWeight: '600' }}>{item.label}</Text>{mode === item.value ? <Icon name="checkmark-circle" color={t.accent} size={15}/> : null}</View>
    </Pressable>)}</View>
    <View style={{ gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 }}>ПАЛИТРЫ</Text>{platina ? null : <Text style={{ color: t.muted, fontSize: 11 }}>· с Platina</Text>}</View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 4 }}>
        {PALETTES.map(p => <PaletteCard key={p.id} id={p.id} locked={!platina} selected={platina && (mode === p.id || (mode === 'system' && darkTheme === p.id))} onPress={() => pick(p.id)} />)}
      </ScrollView>
      {lockedHint && !platina ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Палитры входят в Инвиз Platina. Войди в аккаунт с Platina, чтобы их включить.</Text> : null}
    </View>
    {mode === 'system' ? <View style={{ gap: 9 }}><Text style={{ color: t.muted, fontSize: 12 }}>Когда система переключается на тёмную тему (или выбери палитру выше):</Text><View style={{ flexDirection: 'row', gap: 8 }}>{(['dark', 'black', 'graphite'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: darkTheme === value }} onPress={() => onDarkTheme(value)} style={{ flex: 1, minHeight: 44, borderRadius: 15, borderWidth: 1, borderColor: darkTheme === value ? t.accent : t.border, backgroundColor: darkTheme === value ? t.accentSoft : 'transparent', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}><Text style={{ color: darkTheme === value ? t.text : t.muted, fontSize: 12 }}>{THEME_NAMES[value]}</Text>{darkTheme === value ? <Icon name="checkmark" size={15} color={t.accent}/> : null}</Pressable>)}</View></View> : <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Ручной выбор сохраняется после перезапуска и не зависит от темы устройства.</Text>}
  </View>;
}
