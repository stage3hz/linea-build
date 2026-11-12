// «Снег» on the phone (Настройки › Оформление): snow falls over the app, lies in caps on the Dynamic Island / camera
// cutout, the header buttons, «Поиск» and the tab bar, the glass is rimed, a tap knocks the snow off a button and a
// finger sweeps it away; when the phone really heats up (the system's thermal state) the snow and the rime melt.
// All of it is drawn by ONE native view above the app (modules/linea-snow) that never takes a touch. This file only
// tells it where the ledges are:
//  - <SnowLedge id …> wraps a control whose top edge holds snow and reports its rectangle in window coordinates;
//  - <SnowPhone/> — mounted once at the root: the native surface, the switch, the theme, the island.
// The PC has its own snow (src/Snow.tsx); here everything is a no-op on the web.
import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LineaSnowBridge, LineaSnowViewProps, SnowLedge as Ledge } from '../modules/linea-snow';
import { useTheme } from './theme';
import { useChatPreferences } from './chatPreferences';
import { useMotion } from './motion';
import { useRenderActive } from './renderActivity';
import { islandLedge } from './snowModel';

const onPhone = Platform.OS === 'ios' || Platform.OS === 'android';
const native = onPhone ? (() => { try { return requireOptionalNativeModule<LineaSnowBridge>('LineaSnow'); } catch { return null; } })() : null;
const NativeSnow: React.ComponentType<LineaSnowViewProps & { style?: StyleProp<ViewStyle>; pointerEvents?: 'none' }> | null = native ? (() => { try { return requireNativeViewManager('LineaSnow'); } catch { return null; } })() : null;
const call = (run: () => void) => { try { run(); } catch { /* decorative: never in the way */ } };

// ── The ledges on screen ────────────────────────────────────────────────────────────────────────────────────────
const ledges = new Map<string, Ledge>();
const measurers = new Set<() => void>();
let running = false, pushTimer: ReturnType<typeof setTimeout> | null = null;

function push() {
  if (pushTimer || !native || !running) return;
  pushTimer = setTimeout(() => { pushTimer = null; if (running) call(() => native.setLedges(Array.from(ledges.values()))); }, 40);
}
function setLedge(id: string, ledge: Ledge | null) {
  const before = ledges.get(id);
  if (!ledge) { if (before) { ledges.delete(id); push(); } return; }
  if (before && Math.abs(before.x - ledge.x) < 0.5 && Math.abs(before.y - ledge.y) < 0.5 && Math.abs(before.width - ledge.width) < 0.5 && Math.abs(before.height - ledge.height) < 0.5 && before.radius === ledge.radius && before.max === ledge.max) return;
  ledges.set(id, ledge); push();
}

/**
 * A control whose top edge holds snow. `inset`: how far the visible shape sits inside this wrapper (the margins of
 * the glass inside it). `radius`: the shape's corner radius; `max`: the tallest cap in points.
 */
export function SnowLedge({ id, radius, max = 6, inset, style, children }: { id: string; radius: number; max?: number; inset?: { left?: number; right?: number; top?: number; bottom?: number }; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const ref = useRef<View>(null);
  const active = useRenderActive();
  const shape = useRef({ radius, max, inset }); shape.current = { radius, max, inset };
  const measure = useCallback(() => {
    const view = ref.current;
    if (!view || !running) return;
    view.measureInWindow((x, y, width, height) => {
      const { radius: r, max: m, inset: i } = shape.current;
      const w = width - (i?.left || 0) - (i?.right || 0), h = height - (i?.top || 0) - (i?.bottom || 0);
      if (!(w > 8) || !(h > 8) || !Number.isFinite(x) || !Number.isFinite(y)) { setLedge(id, null); return; }
      setLedge(id, { id, x: x + (i?.left || 0), y: y + (i?.top || 0), width: w, height: h, radius: Math.min(r, h / 2, w / 2), max: m, kind: 'glass' });
    });
  }, [id]);
  useEffect(() => {
    if (!onPhone || !active) { setLedge(id, null); return; }
    measurers.add(measure); measure();
    return () => { measurers.delete(measure); setLedge(id, null); };
  }, [id, active, measure]);
  if (!onPhone) return <View style={style}>{children}</View>;
  return <View ref={ref} collapsable={false} onLayout={measure} style={style}>{children}</View>;
}

/** Mount once at the root, above the screens. */
export function SnowPhone() {
  const t = useTheme();
  const preferences = useChatPreferences();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const enabled = !!native && !!NativeSnow && preferences.snow && motion.enabled;
  useEffect(() => {
    if (!native) return;
    running = enabled;
    call(() => native.setEnabled(enabled));
    if (!enabled) return;
    // Controls move without a layout event of their own (a header growing above them, the keyboard, a rotation):
    // re-measure a few times a second; setLedge ignores unchanged rectangles.
    for (const measure of measurers) measure();
    const timer = setInterval(() => { for (const measure of measurers) measure(); }, 700);
    return () => { clearInterval(timer); running = false; call(() => native.setEnabled(false)); };
  }, [enabled]);
  useEffect(() => { if (native && enabled) call(() => native.setDark(t.dark)); }, [enabled, t.dark]);
  // The Dynamic Island (iPhone) / the camera cutout (Android): snow lies on it too.
  useEffect(() => {
    if (!native || !enabled) return;
    let cutout: { x: number; y: number; width: number; height: number } | null = null;
    if (Platform.OS === 'android') call(() => { cutout = native.cutout(); });
    const island = islandLedge(Platform.OS === 'ios' ? 'ios' : 'android', window.width, window.height, insets.top, cutout);
    setLedge('island', island ? { id: 'island', ...island, max: 5, kind: 'island' } : null);
    return () => setLedge('island', null);
  }, [enabled, window.width, window.height, insets.top]);
  if (!enabled || !NativeSnow) return null;
  return <NativeSnow pointerEvents="none" style={StyleSheet.absoluteFill} active />;
}
