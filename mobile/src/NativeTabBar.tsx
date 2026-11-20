// The phone's tab bar drawn by the phone itself (modules/linea-tabbar): on the iPhone the glass, the capsule with
// its trail, the light, the touches and the list of the other sections are all UIKit. This file only hands it
// what there is and passes on what was chosen. Where the native bar is absent, `NativeTabBar` is null and the
// caller keeps the drawn bar (src/TabBar.tsx).
import React, { useRef } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaTabBarProps } from '../modules/linea-tabbar';
import type { TabItem } from './TabBar';

const View: React.ComponentType<LineaTabBarProps> | null = Platform.OS === 'ios' ? (() => { try { return requireOptionalNativeModule('LineaTabBar') ? requireNativeViewManager('LineaTabBar') : null; } catch { return null; } })() : null;
export const hasNativeTabBar = !!View;

/** SF Symbols for the sections (the filled drawing is taken by the bar itself for the chosen tab). */
const SYMBOLS: Record<string, string> = { ai: 'sparkles', people: 'person.2', channels: 'dot.radiowaves.left.and.right', chats: 'bubble.left.and.bubble.right', music: 'headphones', profile: 'gearshape' };

export function NativeTabBar({ items, bar, active, dark, glow, onUsed, style }: { items: TabItem[]; bar: string[]; active: string; dark: boolean; glow: string[] | null; /** The list of sections was opened: the hint about it is no longer needed. */ onUsed?: () => void; style?: StyleProp<ViewStyle> }) {
  const live = useRef({ items, active }); live.current = { items, active };
  // The section that was open when the finger first rested on a row: a cancelled list goes back to it.
  const origin = useRef<string | null>(null);
  if (!View) return null;
  const open = (id: string) => live.current.items.find(item => item.id === id)?.onPress();
  return <View style={style as object} dark={dark} active={active} bar={bar} glow={glow ?? []} more="Остальные разделы"
    items={items.map(item => ({ id: item.id, label: item.label, symbol: SYMBOLS[item.id] ?? 'circle', badge: item.badge || 0, dot: item.dot ?? '' }))}
    onSelect={event => { const id = event.nativeEvent.id; origin.current = null; if (!bar.includes(id)) onUsed?.(); open(id); }}
    onPreview={event => {
      const id = event.nativeEvent.id; onUsed?.();
      if (id) { if (origin.current === null) origin.current = live.current.active; open(id); }
      else if (origin.current !== null) { const back = origin.current; origin.current = null; open(back); }
    }} />;
}
