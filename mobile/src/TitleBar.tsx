// PC window title bar drawn by the app itself, in its colours: the bar is part of the page
// (transparent over the app background), dragging it moves the window, double click maximizes.
// Windows/Linux: minimize / maximize / close on the right, as in Windows. macOS keeps its native
// traffic lights (hiddenInset) and this is only the drag strip.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';

type Controls = { platform: string; action(a: 'minimize' | 'maximize' | 'close' | 'state'): Promise<{ maximized: boolean; fullscreen: boolean; focused: boolean } | null>; onState(listener: (s: { maximized: boolean; fullscreen: boolean; focused: boolean }) => void): () => void };
const controls = (): Controls | undefined => (globalThis as unknown as { invizentDesktop?: { windowControls?: Controls } }).invizentDesktop?.windowControls;
export const TITLE_BAR_HEIGHT = 30;

export function TitleBar() {
  const t = useTheme(); const c = controls();
  const [state, setState] = useState({ maximized: false, fullscreen: false, focused: true });
  // Electron's drag region is a CSS property react-native-web doesn't know, so it is set on the DOM nodes.
  const region = (value: 'drag' | 'no-drag') => (node: unknown) => { const el = node as HTMLElement | null; if (el?.style) (el.style as unknown as Record<string, string>).webkitAppRegion = value; if (el?.style && value === 'drag') el.style.userSelect = 'none'; };
  const dragRef = useRef(region('drag')).current, noDrag = useRef(region('no-drag')).current;
  useEffect(() => { if (!c) return; void c.action('state').then(s => s && setState(s)); return c.onState(setState); }, [c]);
  // Dialogs (profile, viewer, sheets) start below our title bar, so the window buttons stay usable.
  const shown = Platform.OS === 'web' && !!c && !state.fullscreen && c.platform !== 'darwin';
  useEffect(() => {
    if (!shown || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    // Only the fixed, full-window layers of a dialog are moved (an invisible one would otherwise
    // swallow clicks on the window buttons); ordinary views inside keep their layout.
    let queued = 0; const schedule = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; lift(); }); };
    // The outermost fixed layer is shifted until the dialog itself starts right under the bar —
    // measured, because inner layers may or may not be positioned inside it (animation transforms).
    const lift = () => document.querySelectorAll('[aria-modal="true"]').forEach(node => {
      let outer: HTMLElement | null = null;
      for (let el: HTMLElement | null = node as HTMLElement; el && el !== document.body; el = el.parentElement) if (getComputedStyle(el).position === 'fixed') outer = el;
      if (!outer) return;
      if (outer.getAnimations?.().some(animation => animation.playState === 'running')) { schedule(); return; }
      const delta = TITLE_BAR_HEIGHT - (node as HTMLElement).getBoundingClientRect().top;
      if (Math.abs(delta) > 0.5) outer.style.top = `${(parseFloat(outer.style.top) || 0) + delta}px`;
    });
    lift(); const observer = new MutationObserver(schedule); observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); if (queued) cancelAnimationFrame(queued); };
  }, [shown]);
  if (Platform.OS !== 'web' || !c || state.fullscreen) return null;
  const mac = c.platform === 'darwin';
  if (mac) return <View ref={dragRef} style={{ height: TITLE_BAR_HEIGHT, flexDirection: 'row', alignItems: 'center', backgroundColor: 'transparent', zIndex: 1000 }}>
    <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', color: t.muted, fontSize: 12, fontWeight: '600', opacity: state.focused ? 1 : 0.6 }}>Инвиз</Text>
  </View>;
  // Windows / Linux: the familiar caption buttons on the right (— ☐ ✕), drawn in the app's colours;
  // hover tints them like Windows, «Закрыть» turns red.
  const button = (action: 'minimize' | 'maximize' | 'close', icon: IconName, label: string, size: number) =>
    <Pressable key={action} ref={noDrag} onPress={() => void c.action(action)} accessibilityRole="button" accessibilityLabel={label}
      style={state => ({ width: 46, height: TITLE_BAR_HEIGHT, alignItems: 'center', justifyContent: 'center', backgroundColor: (state as { hovered?: boolean }).hovered ? (action === 'close' ? '#E81123' : (t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)')) : 'transparent', opacity: state.pressed ? 0.75 : 1 })}>
      {state0 => <Icon name={icon} size={size} color={(state0 as { hovered?: boolean }).hovered && action === 'close' ? '#FFFFFF' : (state.focused ? t.text : t.muted)} />}
    </Pressable>;
  return <View ref={dragRef}
    style={{ height: TITLE_BAR_HEIGHT, flexDirection: 'row', alignItems: 'center', backgroundColor: 'transparent', zIndex: 1000 }}>
    <Text numberOfLines={1} style={{ flex: 1, paddingLeft: 14, color: t.muted, fontSize: 12, fontWeight: '600', opacity: state.focused ? 1 : 0.6 }}>Инвиз</Text>
    <View ref={noDrag} style={{ flexDirection: 'row', alignSelf: 'stretch' }}>
      {button('minimize', 'remove-outline', 'Свернуть окно', 18)}
      {button('maximize', state.maximized ? 'copy-outline' : 'square-outline', state.maximized ? 'Восстановить размер окна' : 'Развернуть окно', 14)}
      {button('close', 'close-outline', 'Закрыть окно', 20)}
    </View>
  </View>;
}
