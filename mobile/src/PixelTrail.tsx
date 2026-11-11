// «Пиксельный след» (Настройки › Оформление): a fixed mesh of tiny square tiles that glows in a soft light under
// the finger (phone) and the cursor (PC) and fades behind it — white on dark themes, black on light ones.
// It is part of the BACKGROUND: drawn over the app backdrop / chat wallpaper and under every bubble, card, header
// and bar. Purely decorative: it never takes a touch or a click.
//  - <PixelTrail/> — mounted once at the root: switches the effect on/off (setting, animations, reduce motion) and
//    sets the theme colour.
//  - <PixelTrailLayer/> — the drawing surface, mounted inside each background (GlassBackdrop, the chat wallpaper,
//    the sign-in backdrop). All layers show the same light: one model in window coordinates, each layer draws the
//    part that falls on it, so the mesh stays fixed to the screen whatever the layer's own position is.
//  - iOS / Android: the layer is the native view of modules/linea-trail; touches are observed at window level
//    without being consumed (they are seen even while a list scrolls, which a JS onTouchMove is not).
//  - Web / Electron: the layer is a pointer-events:none <canvas>, fed by window pointer events and drawn with
//    requestAnimationFrame only while the light is alive.
// The rules and constants live in src/pixelTrailModel.ts.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaTrailBridge, LineaTrailViewProps } from '../modules/linea-trail';
import { useTheme } from './theme';
import { useChatPreferences } from './chatPreferences';
import { useMotion } from './motion';
import { useRenderActive } from './renderActivity';
import { PixelTrailModel, TRAIL, trailColor } from './pixelTrailModel';

const onPhone = Platform.OS === 'ios' || Platform.OS === 'android';
const native = onPhone ? (() => { try { return requireOptionalNativeModule<LineaTrailBridge>('LineaTrail'); } catch { return null; } })() : null;
const NativeLayer: React.ComponentType<LineaTrailViewProps & { style?: StyleProp<ViewStyle>; pointerEvents?: 'none' }> | null = native ? (() => { try { return requireNativeViewManager('LineaTrail'); } catch { return null; } })() : null;

const call = (run: () => void) => { try { run(); } catch { /* decorative: never in the way */ } };

/** On when the setting is on and animations are allowed (power saving, «Анимации интерфейса», reduce motion). */
function useTrailEnabled() {
  const preferences = useChatPreferences();
  const motion = useMotion();
  const reduced = useWebReducedMotion(Platform.OS === 'web' && preferences.animations === 'auto');
  return preferences.pixelTrail && motion.enabled && !reduced;
}

/** Mount once inside the theme provider: the switch and the theme colour of every layer. */
export function PixelTrail() {
  const t = useTheme();
  const enabled = useTrailEnabled();
  const color = trailColor(t.dark);
  useEffect(() => { if (native) call(() => native.setColor(color)); else webTrail.setColor(color); }, [color]);
  useEffect(() => { if (native) call(() => native.setEnabled(enabled)); else webTrail.setEnabled(enabled); }, [enabled]);
  useEffect(() => () => { if (native) call(() => native.setEnabled(false)); else webTrail.setEnabled(false); }, []);
  return null;
}

/** The drawing surface: fills its parent, behind the content that follows it. `ink` overrides the theme colour
 *  (a dark wallpaper under a light theme needs white tiles). */
export function PixelTrailLayer({ ink }: { ink?: string }) {
  const enabled = useTrailEnabled();
  // Screens kept mounted under another one stop decorative drawing.
  const active = useRenderActive();
  if (!enabled) return null;
  if (Platform.OS === 'web') return active ? <WebLayer ink={ink} /> : null;
  return NativeLayer ? <NativeLayer pointerEvents="none" style={StyleSheet.absoluteFill} color={ink} active={active} /> : null;
}

/** The browser's «reduce motion» (motion.tsx follows the system setting on the phone only). */
function useWebReducedMotion(watch: boolean) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!watch || typeof window === 'undefined' || typeof window.matchMedia !== 'function') { setReduced(false); return; }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    change();
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, [watch]);
  return reduced;
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type WebSurface = { canvas: HTMLCanvasElement; ink: string | undefined; painted: boolean };

/** One light for the whole window: a model in viewport coordinates, the canvases that show it, one frame loop. */
const webTrail = (() => {
  const model = new PixelTrailModel();
  const surfaces = new Set<WebSurface>();
  // The tiles of a frame are rasterised once per ink colour and composited into every canvas with one soft blur
  // (a filter per tile would be costly).
  const sheets = new Map<string, HTMLCanvasElement>();
  let enabled = false, color = '#FFFFFF', frame = 0, listening = false;
  // One finger only: the first touch leads the light, other touches are ignored while it is down. If the browser
  // cancels the touch mid-swipe while the finger keeps moving, it leads again on its next move.
  let finger: number | null = null;

  const rgb = (ink: string) => ink === '#000000' ? '0,0,0' : '255,255,255';
  const schedule = () => { if (!frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(draw); };

  const sheet = (ink: string, width: number, height: number) => {
    let made = sheets.get(ink);
    if (!made) { made = document.createElement('canvas'); sheets.set(ink, made); }
    if (made.width < width || made.height < height) { made.width = Math.max(made.width, width); made.height = Math.max(made.height, height); }
    return made;
  };

  function draw() {
    frame = 0;
    const now = performance.now(), dpr = window.devicePixelRatio || 1;
    const alive = enabled && surfaces.size > 0 && model.step(now);
    const field = alive ? model.compute(now) : null, bloom = alive ? model.bloom(now) : null;
    const P = TRAIL.PITCH, R = TRAIL.RADIUS, inset = (P - TRAIL.DOT) / 2;
    const ready = new Set<string>();
    // Rasterises the lit tiles in `ink` at the sheet's origin (the field's top-left tile); tiles are snapped to
    // device pixels of the window, so the mesh is the same on every canvas.
    const raster = (ink: string) => {
      if (!field || !field.lit) return null;
      const left0 = Math.round(field.c0 * P * dpr), top0 = Math.round(field.r0 * P * dpr);
      const width = Math.ceil(field.cols * P * dpr) + 2, height = Math.ceil(field.rows * P * dpr) + 2;
      const target = sheet(ink, width, height);
      if (ready.has(ink)) return { target, left0, top0, width, height };
      const context = target.getContext('2d');
      if (!context) return null;
      context.clearRect(0, 0, target.width, target.height);
      context.fillStyle = `rgb(${rgb(ink)})`;
      for (let r = 0; r < field.rows; r++) {
        const top = Math.round(((field.r0 + r) * P + inset) * dpr) - top0, bottom = Math.round(((field.r0 + r) * P + inset + TRAIL.DOT) * dpr) - top0;
        for (let c = 0; c < field.cols; c++) {
          const alpha = field.alpha[r * field.cols + c];
          if (!alpha) continue;
          const left = Math.round(((field.c0 + c) * P + inset) * dpr) - left0, right = Math.round(((field.c0 + c) * P + inset + TRAIL.DOT) * dpr) - left0;
          context.globalAlpha = alpha;
          context.fillRect(left, top, right - left, bottom - top);
        }
      }
      context.globalAlpha = 1;
      ready.add(ink);
      return { target, left0, top0, width, height };
    };
    for (const surface of surfaces) {
      const { canvas } = surface;
      const box = canvas.getBoundingClientRect();
      const width = Math.round(box.width * dpr), height = Math.round(box.height * dpr);
      if (width < 1 || height < 1) continue;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; surface.painted = false; }
      const context = canvas.getContext('2d');
      if (!context) continue;
      if (surface.painted) { context.clearRect(0, 0, width, height); surface.painted = false; }
      if (!alive) continue;
      // The canvas shows the part of the window it covers: window coordinates minus its own origin.
      const ox = Math.round(box.left * dpr), oy = Math.round(box.top * dpr), ink = surface.ink ?? color;
      // 1) The soft bloom under the mesh, at the newest sample.
      if (bloom && bloom.alpha > 0) {
        const cx = bloom.x * dpr - ox, cy = bloom.y * dpr - oy, reach = R * TRAIL.BLOOM_SCALE * dpr;
        if (cx + reach > 0 && cy + reach > 0 && cx - reach < width && cy - reach < height) {
          const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, reach);
          gradient.addColorStop(0, `rgba(${rgb(ink)},${bloom.alpha.toFixed(3)})`);
          gradient.addColorStop(1, `rgba(${rgb(ink)},0)`);
          context.fillStyle = gradient;
          context.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);
          surface.painted = true;
        }
      }
      // 2) The tiles.
      const tiles = raster(ink);
      if (tiles && tiles.left0 - ox < width && tiles.top0 - oy < height && tiles.left0 - ox + tiles.width > 0 && tiles.top0 - oy + tiles.height > 0) {
        context.filter = `blur(${TRAIL.BLUR}px)`;
        context.drawImage(tiles.target, 0, 0, tiles.width, tiles.height, tiles.left0 - ox, tiles.top0 - oy, tiles.width, tiles.height);
        context.filter = 'none';
        surface.painted = true;
      }
    }
    // Idle = no loop once the light has faded out (or nothing is there to show it).
    if (alive) schedule();
  }

  const leads = (event: PointerEvent) => { if (event.pointerType === 'mouse') return true; if (finger === null) finger = event.pointerId; return event.pointerId === finger; };
  const down = (event: PointerEvent) => { if (!leads(event)) return; model.down(event.clientX, event.clientY, performance.now()); schedule(); };
  const move = (event: PointerEvent) => { if (!leads(event)) return; model.point(event.clientX, event.clientY, performance.now()); schedule(); };
  const release = (event: PointerEvent) => { if (event.pointerType !== 'mouse') { if (event.pointerId !== finger) return; finger = null; } model.release(performance.now()); schedule(); };

  /** Pointer events are watched only while the effect is on and some layer is mounted. */
  const listen = () => {
    if (typeof window === 'undefined') return;
    const wanted = enabled && surfaces.size > 0;
    if (wanted === listening) return;
    listening = wanted;
    const change = wanted ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
    change('resize', schedule as EventListener);
    change('pointerdown', down as EventListener, { passive: true });
    change('pointermove', move as EventListener, { passive: true });
    change('pointerup', release as EventListener, { passive: true });
    change('pointercancel', release as EventListener, { passive: true });
    if (!wanted) { finger = null; model.clear(); schedule(); }
  };

  return {
    setEnabled(on: boolean) { enabled = on; listen(); schedule(); },
    setColor(next: string) { color = next; schedule(); },
    add(surface: WebSurface) { surfaces.add(surface); listen(); schedule(); },
    remove(surface: WebSurface) { surfaces.delete(surface); listen(); },
    schedule,
  };
})();

function WebLayer({ ink }: { ink?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const surface = useRef<WebSurface | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const made: WebSurface = { canvas: ref.current, ink, painted: false };
    surface.current = made;
    webTrail.add(made);
    return () => { webTrail.remove(made); surface.current = null; };
  }, []);
  useEffect(() => { if (surface.current) { surface.current.ink = ink; webTrail.schedule(); } }, [ink]);
  return React.createElement('canvas', { ref, 'aria-hidden': true, 'data-pixel-trail': '', style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', userSelect: 'none' } });
}
