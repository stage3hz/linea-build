// «Пиксельный след» (Настройки › Оформление): a fixed mesh of tiny square tiles that glows in a soft light gliding
// after the finger (phone) and the cursor (PC) and fading behind it — white on dark themes, black on light ones.
// Purely decorative: it never takes a touch or a click.
//  - iOS / Android: the native overlay in modules/linea-trail (it sees touches even while a list scrolls, which a
//    JS onTouchMove does not); this component only switches it on/off and sets the colour.
//  - Web / Electron: a fixed pointer-events:none <canvas> over the window, drawn with requestAnimationFrame
//    only while the light is alive.
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
  const redrawRef = useRef<() => void>(() => {});
  useEffect(() => { redrawRef.current(); }, [color]);
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || typeof window === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.pixelTrail = '';
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '2147483647', userSelect: 'none' });
    // Tiles are drawn on a second canvas and composited with one soft blur (a filter per tile would be costly).
    const tiles = document.createElement('canvas');
    const context = canvas.getContext('2d'), tileContext = tiles.getContext('2d');
    if (!context || !tileContext) return;
    document.body.appendChild(canvas);
    const model = new PixelTrailModel();
    let frame = 0, dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      tiles.width = canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
      tiles.height = canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
      schedule();
    };
    const rgb = () => colorRef.current === '#000000' ? '0,0,0' : '255,255,255';
    const draw = () => {
      frame = 0;
      const now = performance.now();
      context.clearRect(0, 0, canvas.width, canvas.height);
      const alive = model.step(now);
      if (alive) {
        const ink = rgb(), R = TRAIL.RADIUS;
        // 1) The soft bloom under the mesh, at the newest sample.
        const bloom = model.bloom(now);
        if (bloom.alpha > 0) {
          const gradient = context.createRadialGradient(bloom.x * dpr, bloom.y * dpr, 0, bloom.x * dpr, bloom.y * dpr, R * TRAIL.BLOOM_SCALE * dpr);
          gradient.addColorStop(0, `rgba(${ink},${bloom.alpha.toFixed(3)})`);
          gradient.addColorStop(1, `rgba(${ink},0)`);
          context.fillStyle = gradient;
          context.fillRect((bloom.x - R * 1.2) * dpr, (bloom.y - R * 1.2) * dpr, R * 2.4 * dpr, R * 2.4 * dpr);
        }
        // 2) The tiles, snapped to the fixed screen grid.
        const field = model.compute(now);
        if (field.lit) {
          const left0 = field.c0 * TRAIL.PITCH * dpr, top0 = field.r0 * TRAIL.PITCH * dpr;
          const width = field.cols * TRAIL.PITCH * dpr, height = field.rows * TRAIL.PITCH * dpr;
          tileContext.clearRect(left0 - 2, top0 - 2, width + 4, height + 4);
          tileContext.fillStyle = `rgb(${ink})`;
          const inset = (TRAIL.PITCH - TRAIL.DOT) / 2;
          for (let r = 0; r < field.rows; r++) {
            const top = Math.round(((field.r0 + r) * TRAIL.PITCH + inset) * dpr), bottom = Math.round(((field.r0 + r) * TRAIL.PITCH + inset + TRAIL.DOT) * dpr);
            for (let c = 0; c < field.cols; c++) {
              const alpha = field.alpha[r * field.cols + c];
              if (!alpha) continue;
              const left = Math.round(((field.c0 + c) * TRAIL.PITCH + inset) * dpr), right = Math.round(((field.c0 + c) * TRAIL.PITCH + inset + TRAIL.DOT) * dpr);
              tileContext.globalAlpha = alpha;
              tileContext.fillRect(left, top, right - left, bottom - top);
            }
          }
          tileContext.globalAlpha = 1;
          context.filter = `blur(${TRAIL.BLUR}px)`;
          context.drawImage(tiles, left0, top0, width, height, left0, top0, width, height);
          context.filter = 'none';
        }
      }
      // Idle = no loop once the light has faded out.
      if (alive) frame = requestAnimationFrame(draw);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    redrawRef.current = schedule;
    // One finger only: the first touch leads the light, other touches are ignored while it is down. If the browser
    // cancels the touch mid-swipe while the finger keeps moving, it leads again on its next move.
    let finger: number | null = null;
    const leads = (event: PointerEvent) => { if (event.pointerType === 'mouse') return true; if (finger === null) finger = event.pointerId; return event.pointerId === finger; };
    const down = (event: PointerEvent) => { if (!leads(event)) return; model.down(event.clientX, event.clientY, performance.now()); schedule(); };
    const move = (event: PointerEvent) => { if (!leads(event)) return; model.point(event.clientX, event.clientY, performance.now()); schedule(); };
    const release = (event: PointerEvent) => { if (event.pointerType !== 'mouse') { if (event.pointerId !== finger) return; finger = null; } model.release(performance.now()); schedule(); };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      canvas.remove();
    };
  }, [enabled]);
  return null;
}
