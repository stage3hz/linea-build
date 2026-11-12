// «Снег»: the drift on the top edge of the app window. This page fills a thin transparent strip that sits just
// above the window (see snowCap in main.cjs); its bottom edge is the window's top edge. Flakes fall through the
// strip and pile up there; the cursor (reported by the main process: the strip itself takes no mouse) sweeps
// the snow off. Same rules as mobile/src/snowModel.ts.
const canvas = document.getElementById('c'), context = canvas.getContext('2d');
const COL = 3, MAX = 13, BRUSH = 26, GAIN = 1.2; // few flakes cross the thin strip, so each one adds more
let W = 0, H = 0, dpr = 1, h = new Float32Array(1), flakes = [], puffs = [], last = performance.now();
let mx = null, my = null, pmx = null, pmy = null;
const flake = anywhere => { const z = Math.random(); return { x: Math.random() * W, y: anywhere ? Math.random() * H : -4, r: 1 + z * 1.8, v: 14 + z * 22, phase: Math.random() * 6.28 }; };
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const columns = Math.max(1, Math.ceil(W / COL));
  if (h.length !== columns) { const next = new Float32Array(columns); next.set(h.subarray(0, Math.min(columns, h.length))); h = next; }
  const want = Math.max(6, Math.min(60, Math.round(W / 34)));
  while (flakes.length < want) flakes.push(flake(true));
  flakes.length = want;
}
function deposit(i, r) {
  // The drift thins out towards the corners of the window.
  const edge = Math.min(i, h.length - 1 - i) * COL, cap = MAX * Math.min(1, edge / 18);
  if (i < 0 || i >= h.length || h[i] >= cap) return;
  let k = i;
  for (let step = 0; step < 3; step++) {
    const left = k > 0 ? h[k - 1] : Infinity, right = k < h.length - 1 ? h[k + 1] : Infinity;
    if (left < h[k] - 0.6 && left <= right) k--; else if (right < h[k] - 0.6) k++; else break;
  }
  h[k] = Math.min(cap, h[k] + r * GAIN);
}
function brush() {
  if (mx === null || pmx === null || Math.hypot(mx - pmx, my - pmy) < 0.5) return;
  const from = Math.max(0, Math.floor((mx - BRUSH) / COL)), to = Math.min(h.length - 1, Math.ceil((mx + BRUSH) / COL));
  for (let i = from; i <= to; i++) {
    if (h[i] <= 0.3) continue;
    const distance = Math.hypot(i * COL - mx, H - h[i] / 2 - my);
    if (distance > BRUSH) continue;
    const taken = Math.min(h[i], h[i] * (1 - distance / BRUSH) * 0.9 + 0.4);
    h[i] -= taken;
    if (puffs.length < 200 && taken > 0.5) puffs.push({ x: i * COL, y: H - h[i], vx: (mx - pmx) * 3 + (Math.random() - 0.5) * 40, vy: -15 - Math.random() * 35, r: 1 + Math.random() * 1.4, age: 0 });
  }
}
function draw(now) {
  requestAnimationFrame(draw);
  if (document.hidden) { last = now; return; }
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  brush(); pmx = mx; pmy = my;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, W, H);
  context.fillStyle = '#FFFFFF';
  context.shadowColor = 'rgba(110,145,200,0.6)';
  context.beginPath(); context.moveTo(0, H);
  for (let i = 0; i < h.length; i++) context.lineTo(i * COL + COL / 2, H - ((i ? h[i - 1] : 0) + 2 * h[i] + (i < h.length - 1 ? h[i + 1] : 0)) / 4);
  context.lineTo(h.length * COL, H); context.closePath();
  context.shadowBlur = 4; context.fill();
  context.shadowBlur = 2;
  const wind = Math.sin(now / 5200) * 8;
  for (let k = 0; k < flakes.length; k++) {
    const f = flakes[k];
    f.y += f.v * dt; f.x += (wind + Math.sin(now / 900 + f.phase) * 6) * dt;
    const i = Math.floor(f.x / COL);
    if (f.x < 0 || f.x > W) { flakes[k] = flake(false); continue; }
    if (f.y >= H - h[Math.max(0, Math.min(h.length - 1, i))]) { deposit(i, f.r); flakes[k] = flake(false); continue; }
    // Flakes appear out of thin air at the top of the strip: fade them in.
    context.globalAlpha = Math.min(1, Math.max(0, f.y / 8)) * 0.9;
    context.beginPath(); context.arc(f.x, f.y, f.r, 0, 6.3); context.fill();
  }
  context.shadowBlur = 0;
  for (let k = puffs.length - 1; k >= 0; k--) {
    const p = puffs[k];
    p.age += dt; p.vy += 300 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.age > 0.9 || p.y > H) { puffs.splice(k, 1); continue; }
    context.globalAlpha = 1 - p.age / 0.9; context.beginPath(); context.arc(p.x, p.y, p.r, 0, 6.3); context.fill();
  }
  context.globalAlpha = 1;
}
window.snowCap?.onCursor((x, y) => { mx = x; my = y; if (x === null) pmx = pmy = null; });
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(draw);
