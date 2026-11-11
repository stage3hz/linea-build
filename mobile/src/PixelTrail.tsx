// «Пиксельный след» (Настройки › Оформление): small grid pixels under the finger (phone) and the cursor (PC),
// white on dark themes and black on light ones. Purely decorative: it never takes a touch or a click.
//  - iOS / Android: the native overlay in modules/linea-trail (it sees touches even while a list scrolls, which a
//    JS onTouchMove does not); this component only switches it on/off and sets the colour.
//  - Web / Electron: a fixed pointer-events:none <canvas> over the window, drawn with requestAnimationFrame
//    only while some pixel is alive.
// The rules and constants live in src/pixelTrailModel.ts.
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaTrailBridge } from '../modules/linea-trail';
import { useTheme } from './theme';
import { useChatPreferences } from './chatPreferences';
import { useMotion } from './motion';
import { PixelTrailModel, TRAIL, trailColor } from './pixelTrailModel';

const native = Platform.OS === 'ios' || Platform.OS === 'android' ? (() => { try { return requireOptionalNativeModule<LineaTrailBridge>('LineaTrail'); } catch { return null; } })() : null;

const call = (run: () => void) => { try { run(); } catch { /* decorative: never in the way */ } };

/** Mount once inside the theme provider. */
export function PixelTrail() {
  const t = useTheme();
  const preferences = useChatPreferences();
  const motion = useMotion();
  const reduced = useWebReducedMotion(Platform.OS === 'web' && preferences.animations === 'auto');
  const enabled = preferences.pixelTrail && motion.enabled && !reduced;
  const color = trailColor(t.dark);

  useEffect(() => { if (native) call(() => native.setColor(color)); }, [color]);
  useEffect(() => { if (native) call(() => native.setEnabled(enabled)); }, [enabled]);
  useEffect(() => () => { if (native) call(() => native.setEnabled(false)); }, []);

  return Platform.OS === 'web' ? <WebTrail enabled={enabled} color={color} /> : null;
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

function WebTrail({ enabled, color }: { enabled: boolean; color: string }) {
  const colorRef = useRef(color); colorRef.current = color;
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || typeof window === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.pixelTrail = '';
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '2147483647', userSelect: 'none' });
    const context = canvas.getContext('2d');
    if (!context) return;
    document.body.appendChild(canvas);
    const model = new PixelTrailModel();
    let frame = 0, dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
      canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
      if (!frame) context.clearRect(0, 0, canvas.width, canvas.height);
    };
    const draw = () => {
      frame = 0;
      const now = performance.now();
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!model.alive(now)) return;// idle: no loop until the pointer moves again
      context.fillStyle = colorRef.current;
      const cell = TRAIL.GRID * dpr;
      for (let i = 0; i < TRAIL.MAX_LIVE; i++) {
        const alpha = model.alpha(i, now);
        if (!alpha) continue;
        // Snapped to device pixels so the squares stay crisp.
        const x = Math.round(model.cx[i] * cell), y = Math.round(model.cy[i] * cell), side = Math.round(model.size[i] * cell);
        context.globalAlpha = alpha;
        context.fillRect(x, y, side, side);
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    const move = (event: PointerEvent) => {
      if (model.move(event.pointerId, event.clientX, event.clientY, performance.now()) && !frame) frame = requestAnimationFrame(draw);
    };
    // A mouse keeps hovering after a click; a finger or pen stroke ends when it lifts.
    const lift = (event: PointerEvent) => { if (event.pointerType !== 'mouse' || event.type === 'pointercancel') model.lift(event.pointerId); };
    const leave = () => model.liftAll();
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', lift, { passive: true });
    window.addEventListener('pointercancel', lift, { passive: true });
    window.addEventListener('blur', leave);
    document.documentElement.addEventListener('mouseleave', leave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
      window.removeEventListener('blur', leave);
      document.documentElement.removeEventListener('mouseleave', leave);
      canvas.remove();
    };
  }, [enabled]);
  return null;
}
