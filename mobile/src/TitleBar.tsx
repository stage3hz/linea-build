// PC window title bar drawn by the app itself, in its colours (macOS style): the bar is part of
// the page (transparent over the app background), dragging it moves the window, double click
// maximizes, and on Windows/Linux the three "traffic lights" close / minimize / maximize.
// On macOS the native lights are kept (hiddenInset) and this is only the drag strip.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Text } from './typography';
import { useTheme } from './theme';

type Controls = { platform: string; action(a: 'minimize' | 'maximize' | 'close' | 'state'): Promise<{ maximized: boolean; fullscreen: boolean; focused: boolean } | null>; onState(listener: (s: { maximized: boolean; fullscreen: boolean; focused: boolean }) => void): () => void };
const controls = (): Controls | undefined => (globalThis as unknown as { invizentDesktop?: { windowControls?: Controls } }).invizentDesktop?.windowControls;
export const TITLE_BAR_HEIGHT = 30;

export function TitleBar() {
  const t = useTheme(); const c = controls();
  const [state, setState] = useState({ maximized: false, fullscreen: false, focused: true });
  const [hover, setHover] = useState(false);
  // Electron's drag region is a CSS property react-native-web doesn't know, so it is set on the DOM nodes.
  const region = (value: 'drag' | 'no-drag') => (node: unknown) => { const el = node as HTMLElement | null; if (el?.style) (el.style as unknown as Record<string, string>).webkitAppRegion = value; if (el?.style && value === 'drag') el.style.userSelect = 'none'; };
  const dragRef = useRef(region('drag')).current, noDrag = useRef(region('no-drag')).current;
  useEffect(() => { if (!c) return; void c.action('state').then(s => s && setState(s)); return c.onState(setState); }, [c]);
  if (Platform.OS !== 'web' || !c || state.fullscreen) return null;
  const mac = c.platform === 'darwin';
  const light = (color: string, glyph: string, action: 'close' | 'minimize' | 'maximize', label: string) =>
    <Pressable key={action} hitSlop={4} onPress={() => void c.action(action)} accessibilityRole="button" accessibilityLabel={label}
      style={{ width: 13, height: 13, borderRadius: 6.5, alignItems: 'center', justifyContent: 'center', backgroundColor: state.focused || hover ? color : (t.dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'), borderWidth: 0.5, borderColor: 'rgba(0,0,0,0.18)'}} ref={noDrag}>
      {hover ? <Text style={{ fontSize: 10, lineHeight: 11, fontWeight: '800', color: 'rgba(0,0,0,0.55)', marginTop: -1 }}>{glyph}</Text> : null}
    </Pressable>;
  return <View ref={dragRef}
    style={{ height: TITLE_BAR_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, backgroundColor: 'transparent', zIndex: 1000 }}>
    {mac ? <View style={{ width: 70 }} /> : <View ref={noDrag} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} style={{ flexDirection: 'row', gap: 8 }}>
      {light('#FF5F57', '×', 'close', 'Закрыть окно')}
      {light('#FEBC2E', '−', 'minimize', 'Свернуть окно')}
      {light('#28C840', state.maximized ? '−' : '+', 'maximize', state.maximized ? 'Восстановить размер окна' : 'Развернуть окно')}
    </View>}
    <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', color: t.muted, fontSize: 12, fontWeight: '600', marginRight: mac ? 70 : 56, opacity: state.focused ? 1 : 0.6 }}>Инвиз</Text>
  </View>;
}
