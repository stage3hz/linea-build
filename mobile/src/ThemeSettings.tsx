import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { PALETTES, paletteThemes } from './themes/palettes';
import { Text } from './typography';
import { Icon } from './components';
import { useTheme } from './theme';
import { setChatPreferences } from './chatPreferences';
import { DAY_STATE, type NightState } from './nightTheme';
import { themeFor, themeTapPlan } from './themePreference';
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
 *
 * The checked card is the theme on screen right now (Telegram), and a tap always shows the
 * tapped theme: at night a dark card becomes the night theme, «Светлая» turns the night mode
 * off by hand; by day the card is the day theme (`themeTapPlan`).
 */
export function ThemeSettings({ mode, darkTheme, nightState = DAY_STATE, onChange, onDarkTheme, platina = false, onLocked }: {
  mode: ThemeMode; darkTheme: DarkTheme; nightState?: NightState; onChange: (mode: ThemeMode) => void; onDarkTheme: (mode: DarkTheme) => void;
  platina?: boolean; onLocked?: () => void;
}) {
  const t = useTheme();
  const [lockedHint, setLockedHint] = useState(false);
  // The night state comes from the one hook instance in App (no second brightness poller, no
  // frame where this screen and the rest of the app disagree about the night).
  const { night, auto, known } = nightState;
  const shown = themeFor(mode, darkTheme, night);
  const choose = (value: ThemeMode) => {
    const plan = themeTapPlan(value, night);
    // Before the brightness is read the rule is unknown; the night can be on here only by hand, so
    // «the rule said night» is the safe stamp: if the rule turns out to say day, the switch simply
    // expires into the day the person asked for, instead of snapping back to night.
    if (plan.nightOff) setChatPreferences({ nightForced: false, nightForcedAt: known ? auto : true });
    if (plan.darkTheme) onDarkTheme(plan.darkTheme);
    if (plan.mode) onChange(plan.mode);
  };
  const pick = (id: (typeof PALETTES)[number]['id']) => {
    if (!platina) { if (onLocked) onLocked(); else setLockedHint(true); return; }
    choose(id);
  };
  return <View style={{ gap: 16 }}>
    {/* When the night theme turns on by itself is set in «Ночной режим» below (Telegram). */}
    <View style={{ flexDirection: 'row', gap: 9 }}>{appearances.map(item => { const selected = shown === item.value; return <Pressable key={item.value} onPress={() => choose(item.value)} accessibilityRole="radio" accessibilityLabel={`${item.label} тема`} accessibilityState={{ selected }} style={{ flex: 1, minHeight: 110, gap: 10, padding: 10, borderRadius: 20, borderWidth: 1, borderColor: selected ? t.accent : t.border, backgroundColor: selected ? t.accentSoft : 'transparent' }}>
      <View style={{ height: 51, borderRadius: 12, backgroundColor: item.color, borderWidth: 1, borderColor: item.line, padding: 8, gap: 5 }}><View style={{ width: '68%', height: 7, borderRadius: 4, backgroundColor: item.line }}/><View style={{ width: '48%', height: 7, borderRadius: 4, backgroundColor: item.line }}/><View style={{ alignSelf: 'flex-end', width: '52%', height: 7, borderRadius: 4, backgroundColor: item.line }}/></View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4 }}><Text style={{ color: selected ? t.text : t.muted, fontSize: 12, fontWeight: '600' }}>{item.label}</Text>{selected ? <Icon name="checkmark-circle" color={t.accent} size={15}/> : null}</View>
    </Pressable>; })}</View>
    <View style={{ gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 }}>ПАЛИТРЫ</Text>{platina ? null : <Text style={{ color: t.muted, fontSize: 11 }}>· с Platina</Text>}</View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 4 }}>
        {PALETTES.map(p => <PaletteCard key={p.id} id={p.id} locked={!platina} selected={platina && shown === p.id} onPress={() => pick(p.id)} />)}
      </ScrollView>
      {lockedHint && !platina ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Палитры входят в Инвиз Platina. Войди в аккаунт с Platina, чтобы их включить.</Text> : null}
    </View>
  </View>;
}
