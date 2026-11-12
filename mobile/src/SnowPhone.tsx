// «Снег» on the phone (Настройки › Оформление): snow falls over the app, lies in caps on the Dynamic Island / camera
// cutout, the header buttons, «Поиск» and the tab bar, the glass is rimed, a tap knocks the snow off a button and a
// finger sweeps it away; when the phone really heats up (the system's thermal state) the snow and the rime melt.
// The caps, the rime and the snow that falls off are drawn by ONE native view above the app (modules/linea-snow); the
// falling snow itself is drawn behind the content, by a layer inside each screen's background. Neither ever takes a
// touch. This file tells the native side where the ledges are:
//  - <SnowLedge id …> wraps a control whose top edge holds snow and reports its rectangle in window coordinates;
//  - <SnowPhone/> — mounted once at the root: the front surface, the switch, the theme, the island;
//  - <SnowBackLayer/> — the falling snow, placed in the backgrounds next to PixelTrailLayer.
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
// The ledges are handed to the native side only once the app's layout has settled after launch (see SnowPhone): until
// the safe-area insets arrive the header sits a status bar higher, and caps were drawn there for a moment.
let settled = false;

function push() {
  if (pushTimer || !native || !running || !settled) return;
  pushTimer = setTimeout(() => { pushTimer = null; if (running && settled) call(() => native.setLedges(Array.from(ledges.values()))); }, 40);
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
  // A rectangle is reported only once two measurements in a row agree: while the app starts, a screen slides in or
  // a header changes height, a control is measured at places it only passes through (the header buttons were seen
  // under the status bar for a moment at launch, with snow and rime drawn there).
  const seen = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measure = useCallback(() => {
    const view = ref.current;
    if (!view || !running) return;
    view.measureInWindow((x, y, width, height) => {
      const { radius: r, max: m, inset: i } = shape.current;
      const w = width - (i?.left || 0) - (i?.right || 0), h = height - (i?.top || 0) - (i?.bottom || 0);
      if (!(w > 8) || !(h > 8) || !Number.isFinite(x) || !Number.isFinite(y)) { seen.current = null; setLedge(id, null); return; }
      const now = { x: x + (i?.left || 0), y: y + (i?.top || 0), w, h }, before = seen.current;
      seen.current = now;
      if (!before || Math.abs(before.x - now.x) > 0.5 || Math.abs(before.y - now.y) > 0.5 || Math.abs(before.w - now.w) > 0.5 || Math.abs(before.h - now.h) > 0.5) {
        // Moving or just appeared: no snow on it until it comes to rest.
        setLedge(id, null);
        if (again.current) clearTimeout(again.current);
        again.current = setTimeout(() => { again.current = null; measureRef.current(); }, 140);
        return;
      }
      setLedge(id, { id, x: now.x, y: now.y, width: w, height: h, radius: Math.min(r, h / 2, w / 2), max: m, kind: 'glass' });
    });
  }, [id]);
  const measureRef = useRef(measure); measureRef.current = measure;
  useEffect(() => () => { if (again.current) clearTimeout(again.current); }, []);
  useEffect(() => {
    if (!onPhone || !active) { setLedge(id, null); return; }
    measurers.add(measure); measure();
    return () => { measurers.delete(measure); setLedge(id, null); };
  }, [id, active, measure]);
  if (!onPhone) return <View style={style}>{children}</View>;
  return <View ref={ref} collapsable={false} onLayout={measure} style={style}>{children}</View>;
}

/** «Ледяное стекло»: rime along the rim of a glass surface — its own setting, independent of the snow. A small native
 *  view inside the glass (so it scrolls and clips with it); it melts away as the phone heats up. */
export function IceLayer({ radius }: { radius: number }) {
  const preferences = useChatPreferences();
  if (!NativeSnow || !preferences.ice) return null;
  return <NativeSnow pointerEvents="none" style={StyleSheet.absoluteFill} layer="rime" radius={radius} />;
}

/** The falling snow: part of a screen's background (beside PixelTrailLayer), so it passes behind the content. */
export function SnowBackLayer() {
  const preferences = useChatPreferences();
  const motion = useMotion();
  const active = useRenderActive();
  if (!NativeSnow || !preferences.snow || !motion.enabled) return null;
  return <NativeSnow pointerEvents="none" style={StyleSheet.absoluteFill} layer="back" active={active} />;
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
    // Nothing is reported until the layout has settled: the insets are known (or clearly will not come) and half a
    // second has passed. Then every control is measured afresh — a rectangle taken earlier may be a status bar off.
    const ready = insets.top > 0 || Platform.OS !== 'ios';
    const remeasure = () => { for (const measure of measurers) measure(); };
    const start = setTimeout(() => {
      // What was measured before now is dropped, not sent: only the island's rectangle does not depend on the layout.
      for (const id of Array.from(ledges.keys())) if (id !== 'island') ledges.delete(id);
      settled = true; push(); remeasure();
    }, ready ? 500 : 1500);
    // Controls move without a layout event of their own (a header growing above them, the keyboard, a rotation):
    // re-measure a few times a second; setLedge ignores unchanged rectangles.
    const timer = setInterval(remeasure, 400);
    return () => { clearTimeout(start); clearInterval(timer); running = false; settled = false; call(() => native.setEnabled(false)); };
  }, [enabled, insets.top > 0]);
  // The theme also colours the rime of «Ледяное стекло», which does not depend on the snow being on.
  useEffect(() => { if (native && (enabled || preferences.ice)) call(() => native.setDark(t.dark)); }, [enabled, preferences.ice, t.dark]);
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
  return <NativeSnow pointerEvents="none" style={StyleSheet.absoluteFill} layer="front" active />;
}
