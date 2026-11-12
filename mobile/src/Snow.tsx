// «Снег» (Настройки › Оформление, PC only): snow falls across the window, lies in drifts on message bubbles, the
// message field, the tab bar and the bottom of the window, and the cursor sweeps it off. In the desktop app the
// main process also keeps a drift on the top edge of the window itself (desktop/snow.html).
// Purely decorative: one pointer-events:none <canvas> above the page; it never takes a click.
//  - Ledges are found in the DOM: bubbles carry data-snow (snowLedge()), the message field and the tab bar are
//    found by their existing test id / role. A ledge covered by something else (a sheet, a menu, the header a
//    bubble scrolled under) holds no snow: the element under its top edge must be the ledge itself.
//  - A drift belongs to its element, so it travels with the bubble while the list scrolls.
// The rules and constants live in src/snowModel.ts.
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { useChatPreferences } from './chatPreferences';
import { useMotion } from './motion';
import { desktopBridge } from './desktop';
import { SNOW, snowBrush, snowCeiling, snowColumns, snowDeposit, snowSurface } from './snowModel';

const LEDGES = '[data-snow],[data-testid="chat-composer"],[role="tablist"]';

/** Spread into a View / Pressable whose top edge holds snow on the PC. */
export const snowLedge = (on = true): object => Platform.OS === 'web' && on ? { dataSet: { snow: '1' } } : {};

type Flake = { x: number; y: number; r: number; v: number; phase: number; alpha: number };
type Ledge = { x: number; y: number; h: Float32Array; cap: number; seed: number };
type Puff = { x: number; y: number; vx: number; vy: number; r: number; age: number };

function startSnow(): () => void {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2147483000' });
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  const drifts = new WeakMap<Element, { h: Float32Array; seed: number }>();
  let scans = 0;
  let floor = new Float32Array(1);
  let elements: Element[] = [], found = 0;
  const flakes: Flake[] = [], puffs: Puff[] = [];
  let W = 0, H = 0, dpr = 1, frame = 0, last = performance.now();
  let mx = -999, my = -999, pmx = -999, pmy = -999;

  const flake = (anywhere: boolean): Flake => { const z = Math.random(); return { x: Math.random() * W, y: anywhere ? Math.random() * H : -6, r: 1 + z * 2.2, v: 28 + z * 46, phase: Math.random() * 6.28, alpha: 0.45 + z * 0.5 }; };

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const columns = Math.ceil(W / SNOW.COL);
    // The bottom of the window starts under snow as well.
    if (floor.length !== columns) { floor = new Float32Array(columns); for (let i = 0; i < columns; i++) floor[i] = snowCeiling(i, columns, SNOW.FLOOR_MAX, 7) * 0.8; }
    const want = Math.min(400, Math.round(SNOW.FLAKES * W * H / (1280 * 800)));
    while (flakes.length < want) flakes.push(flake(true));
    flakes.length = want;
  };

  /** The ledges on screen right now, the bottom of the window last. */
  const ledges = (now: number): Ledge[] => {
    if (now - found > 300) { elements = Array.from(document.querySelectorAll(LEDGES)); found = now; scans++; }
    const list: Ledge[] = [], fresh: { h: Float32Array; seed: number }[] = [];
    for (const element of elements) {
      if (!element.isConnected) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 24 || box.height < 12 || box.top < 4 || box.top > H || box.right < 0 || box.left > W) continue;
      const over = document.elementFromPoint(box.left + box.width / 2, box.top + 3);
      if (!over || !(over === element || element.contains(over))) continue;
      const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      const columns = snowColumns(box.width, radius);
      let drift = drifts.get(element);
      if (!drift || drift.h.length !== columns) { drift = { h: new Float32Array(columns), seed: Math.random() * 100 }; drifts.set(element, drift); fresh.push(drift); }
      list.push({ x: box.left + radius * 0.6, y: box.top + 1, h: drift.h, cap: SNOW.MAX, seed: drift.seed });
    }
    // The snow already lies on what was there when the snow started or a screen opened (several ledges at once);
    // a single new ledge — a message that has just arrived — starts bare and gathers snow.
    if (fresh.length > 2 || scans <= 1) for (const drift of fresh) for (let i = 0; i < drift.h.length; i++) drift.h[i] = snowCeiling(i, drift.h.length, SNOW.MAX, drift.seed) * 0.8;
    list.push({ x: 0, y: H, h: floor, cap: SNOW.FLOOR_MAX, seed: 7 });
    return list;
  };

  const draw = (now: number) => {
    frame = requestAnimationFrame(draw);
    if (!context || document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const all = ledges(now);
    const wind = Math.sin(now / 5200) * 14 + Math.sin(now / 1700) * 5;
    if (mx >= 0 && Math.hypot(mx - pmx, my - pmy) >= 0.5) for (const ledge of all) snowBrush(ledge.h, ledge.x, ledge.y, mx, my, (column, taken) => {
      if (puffs.length < 400 && taken > 0.5) puffs.push({ x: ledge.x + column * SNOW.COL, y: ledge.y - ledge.h[column], vx: (mx - pmx) * 3 + (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 50, r: 1 + Math.random() * 1.6, age: 0 });
    });
    pmx = mx; pmy = my;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, W, H);
    // White snow with a cold shadow: the shadow is what keeps it visible on a light theme.
    const shade = 'rgba(110,145,200,0.6)';
    context.fillStyle = '#FFFFFF';
    for (const ledge of all) {
      const { h } = ledge;
      let any = false;
      for (let i = 0; i < h.length; i++) if (h[i] > 0.3) { any = true; break; }
      if (!any) continue;
      context.beginPath(); context.moveTo(ledge.x, ledge.y);
      for (let i = 0; i < h.length; i++) context.lineTo(ledge.x + i * SNOW.COL + SNOW.COL / 2, ledge.y - snowSurface(h, i));
      context.lineTo(ledge.x + h.length * SNOW.COL, ledge.y); context.closePath();
      // Lit from above: white on top, a cold shade where the drift meets the ledge.
      const fill = context.createLinearGradient(0, ledge.y - ledge.cap, 0, ledge.y);
      fill.addColorStop(0, SNOW.TOP); fill.addColorStop(1, SNOW.BOTTOM);
      context.fillStyle = fill;
      context.shadowColor = shade; context.shadowBlur = 4; context.shadowOffsetY = 1;
      context.fill();
    }
    context.shadowOffsetY = 0; context.shadowBlur = 3;
    context.fillStyle = '#FFFFFF';
    for (let k = 0; k < flakes.length; k++) {
      const f = flakes[k];
      f.y += f.v * dt; f.x += (wind * f.r * 0.5 + Math.sin(now / 900 + f.phase) * 10) * dt;
      if (f.x < -5) f.x = W + 5; else if (f.x > W + 5) f.x = -5;
      let landed = f.y > H + 6;
      if (!landed) for (const ledge of all) {
        const i = Math.floor((f.x - ledge.x) / SNOW.COL);
        if (i < 0 || i >= ledge.h.length) continue;
        const top = ledge.y - ledge.h[i];
        if (f.y >= top && f.y < top + 8) { snowDeposit(ledge.h, i, f.r, snowCeiling(i, ledge.h.length, ledge.cap, ledge.seed)); landed = true; break; }
      }
      if (landed) { flakes[k] = flake(false); continue; }
      context.globalAlpha = f.alpha; context.beginPath(); context.arc(f.x, f.y, f.r, 0, 6.3); context.fill();
    }
    context.shadowBlur = 0;
    for (let k = puffs.length - 1; k >= 0; k--) {
      const p = puffs[k];
      p.age += dt; p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.age > 1.1 || p.y > H) { puffs.splice(k, 1); continue; }
      context.globalAlpha = 1 - p.age / 1.1; context.beginPath(); context.arc(p.x, p.y, p.r, 0, 6.3); context.fill();
    }
    context.globalAlpha = 1;
  };

  const move = (event: PointerEvent) => { if (event.pointerType === 'mouse') { mx = event.clientX; my = event.clientY; } };
  const leave = () => { mx = -999; my = -999; };
  window.addEventListener('pointermove', move, { passive: true });
  document.documentElement.addEventListener('pointerleave', leave);
  window.addEventListener('resize', resize);
  resize();
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', move);
    document.documentElement.removeEventListener('pointerleave', leave);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
}

/** Mount once at the root. Web / Electron only; off with the setting, with animations off and in power saving. */
export function Snow() {
  const preferences = useChatPreferences();
  const motion = useMotion();
  const on = Platform.OS === 'web' && preferences.snow && motion.enabled;
  useEffect(() => {
    if (!on || typeof document === 'undefined') return;
    if (preferences.animations === 'auto' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const stop = startSnow();
    // The drift on the top edge of the window is drawn by the desktop app itself; older builds lack it.
    void desktopBridge()?.snow?.cap(true).catch(() => {});
    return () => { stop(); void desktopBridge()?.snow?.cap(false).catch(() => {}); };
  }, [on, preferences.animations]);
  return null;
}
