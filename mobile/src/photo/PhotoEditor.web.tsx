// Compact photo editor for the PC app (Telegram Desktop-like): the photo in the middle, a thin
// toolbar under it. Crop (free / 1:1 / 4:3 / 16:9, drag the frame or its corners), rotate 90°,
// flip, draw with a pen, undo. Saving re-encodes the picture in the browser, which also drops
// EXIF/GPS metadata; PNG keeps transparency, everything else becomes JPEG.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import { Icon, type IconName } from '../components';
import { useTheme } from '../theme';
import type { LocalFile } from '../types';

type Crop = { x: number; y: number; w: number; h: number }; // normalized to the rotated image
type Stroke = { color: string; width: number; points: { x: number; y: number }[] }; // normalized to the rotated image
type Tool = 'crop' | 'draw' | null;
type Snapshot = { rotation: number; flip: boolean; crop: Crop; strokes: Stroke[] };
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
const COLORS = ['#FFFFFF', '#111111', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#AF52DE'];
const ASPECTS: { label: string; value: number | null }[] = [{ label: 'Свободно', value: null }, { label: '1:1', value: 1 }, { label: '4:3', value: 4 / 3 }, { label: '3:4', value: 3 / 4 }, { label: '16:9', value: 16 / 9 }];
const MAX_SIDE = 4096, MIN_CROP = 0.04;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Draws the photo rotated/flipped into a canvas of the rotated size. */
function drawBase(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, rotation: number, flip: boolean, width: number, height: number) {
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(rotation * Math.PI / 2);
  if (flip) ctx.scale(-1, 1);
  const w = rotation % 2 ? height : width, h = rotation % 2 ? width : height;
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}
function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], width: number, height: number) {
  const unit = Math.min(width, height);
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width * unit; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x * width, p.y * height);
    if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x * width + 0.01, stroke.points[0].y * height);
    ctx.stroke();
  }
}

export function PhotoEditor({ file, onCancel, onReady }: { file: LocalFile; onCancel: () => void; onReady: (file: LocalFile) => Promise<void> }) {
  const t = useTheme(); const win = useWindowDimensions();
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>(null); const [aspect, setAspect] = useState<number | null>(null);
  const [color, setColor] = useState(COLORS[2]); const [penSize, setPenSize] = useState(0.012);
  const [state, setState] = useState<Snapshot>({ rotation: 0, flip: false, crop: FULL, strokes: [] });
  const history = useRef<Snapshot[]>([]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ kind: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'new' | 'draw'; start: { x: number; y: number }; crop: Crop } | null>(null);

  useEffect(() => {
    let alive = true, made: ImageBitmap | null = null;
    (async () => {
      try {
        const blob = file.file || await (await fetch(file.uri)).blob();
        made = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
        if (alive) setBitmap(made); else made.close();
      } catch { if (alive) setError('Этот формат фото нельзя открыть в редакторе. Его можно отправить без изменений.'); }
    })();
    return () => { alive = false; made?.close(); };
  }, [file]);

  const rotated = useMemo(() => bitmap ? (state.rotation % 2 ? { w: bitmap.height, h: bitmap.width } : { w: bitmap.width, h: bitmap.height }) : null, [bitmap, state.rotation]);
  // Fit the rotated photo into the free area (toolbar 120 px, top bar 56 px).
  const view = useMemo(() => {
    if (!rotated) return null;
    const maxW = Math.max(200, Math.min(win.width - 48, 1100)), maxH = Math.max(160, win.height - 56 - 150);
    const scale = Math.min(maxW / rotated.w, maxH / rotated.h);
    return { w: Math.round(rotated.w * scale), h: Math.round(rotated.h * scale) };
  }, [rotated, win.width, win.height]);

  const push = (next: Partial<Snapshot>) => { history.current.push(state); if (history.current.length > 60) history.current.shift(); setState({ ...state, ...next }); };
  const undo = useCallback(() => { const prev = history.current.pop(); if (prev) setState(prev); }, []);

  // Paint the preview (whole rotated photo + drawings; the crop is shown as a frame over it).
  useEffect(() => {
    const c = canvas.current; if (!c || !bitmap || !view) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = Math.round(view.w * ratio); c.height = Math.round(view.h * ratio);
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    drawBase(ctx, bitmap, state.rotation, state.flip, c.width, c.height);
    drawStrokes(ctx, state.strokes, c.width, c.height);
  }, [bitmap, view, state]);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };
  const withAspect = (crop: Crop, anchor: 'nw' | 'ne' | 'sw' | 'se' | 'new'): Crop => {
    if (!aspect || !rotated) return crop;
    const target = aspect * rotated.h / rotated.w; // w/h in normalized units
    let { x, y, w, h } = crop;
    if (w / h > target) w = h * target; else h = w / target;
    if (anchor === 'nw') { x = crop.x + crop.w - w; y = crop.y + crop.h - h; }
    if (anchor === 'ne') { y = crop.y + crop.h - h; }
    if (anchor === 'sw') { x = crop.x + crop.w - w; }
    return { x, y, w, h };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!tool || !stage.current) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = point(e);
    if (tool === 'draw') { history.current.push(state); setState(s => ({ ...s, strokes: [...s.strokes, { color, width: penSize, points: [p] }] })); drag.current = { kind: 'draw', start: p, crop: state.crop }; return; }
    const c = state.crop, near = (a: number, b: number) => Math.abs(a - b) < 0.04;
    let kind: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'new' = 'new';
    if (near(p.x, c.x) && near(p.y, c.y)) kind = 'nw'; else if (near(p.x, c.x + c.w) && near(p.y, c.y)) kind = 'ne';
    else if (near(p.x, c.x) && near(p.y, c.y + c.h)) kind = 'sw'; else if (near(p.x, c.x + c.w) && near(p.y, c.y + c.h)) kind = 'se';
    else if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) kind = 'move';
    history.current.push(state);
    drag.current = { kind, start: p, crop: c };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const p = point(e);
    if (d.kind === 'draw') { setState(s => { const strokes = s.strokes.slice(); const last = strokes[strokes.length - 1]; if (!last || last.points.length > 4000) return s; strokes[strokes.length - 1] = { ...last, points: [...last.points, p] }; return { ...s, strokes }; }); return; }
    const c = d.crop; let next: Crop;
    if (d.kind === 'move') next = { ...c, x: clamp(c.x + p.x - d.start.x, 0, 1 - c.w), y: clamp(c.y + p.y - d.start.y, 0, 1 - c.h) };
    else if (d.kind === 'new') next = withAspect({ x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) }, 'se');
    else {
      const left = d.kind === 'nw' || d.kind === 'sw' ? p.x : c.x, right = d.kind === 'ne' || d.kind === 'se' ? p.x : c.x + c.w;
      const top = d.kind === 'nw' || d.kind === 'ne' ? p.y : c.y, bottom = d.kind === 'sw' || d.kind === 'se' ? p.y : c.y + c.h;
      next = withAspect({ x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(bottom - top) }, d.kind);
    }
    if (next.w >= MIN_CROP && next.h >= MIN_CROP && next.x >= 0 && next.y >= 0 && next.x + next.w <= 1.0001 && next.y + next.h <= 1.0001) setState(s => ({ ...s, crop: next }));
  };
  const onUp = () => { drag.current = null; };

  const pickAspect = (value: number | null) => {
    setAspect(value);
    if (!value || !rotated) return;
    const target = value * rotated.h / rotated.w;
    let w = 1, h = 1; if (target > 1) h = 1 / target; else w = target;
    push({ crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } });
  };
  const rotate = () => push({ rotation: (state.rotation + 3) % 4, crop: FULL, strokes: [] });
  const flip = () => push({ flip: !state.flip, crop: FULL, strokes: [] });
  const reset = () => { history.current.push(state); setState({ rotation: 0, flip: false, crop: FULL, strokes: [] }); setAspect(null); };
  const edited = state.rotation !== 0 || state.flip || state.strokes.length > 0 || state.crop !== FULL && (state.crop.w < 0.999 || state.crop.h < 0.999);

  const save = async () => {
    if (!bitmap || !rotated || busy) return;
    setBusy(true); setError(''); let uri = '';
    try {
      const full = document.createElement('canvas'); full.width = rotated.w; full.height = rotated.h;
      const fctx = full.getContext('2d'); if (!fctx) throw new Error('Не удалось обработать фото.');
      drawBase(fctx, bitmap, state.rotation, state.flip, rotated.w, rotated.h);
      drawStrokes(fctx, state.strokes, rotated.w, rotated.h);
      const sx = Math.round(state.crop.x * rotated.w), sy = Math.round(state.crop.y * rotated.h);
      const sw = Math.max(1, Math.round(state.crop.w * rotated.w)), sh = Math.max(1, Math.round(state.crop.h * rotated.h));
      const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
      const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(sw * scale)); out.height = Math.max(1, Math.round(sh * scale));
      const octx = out.getContext('2d'); if (!octx) throw new Error('Не удалось обработать фото.');
      const png = /png|webp|gif/i.test(file.mimeType);
      if (!png) { octx.fillStyle = '#FFFFFF'; octx.fillRect(0, 0, out.width, out.height); }
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const type = png ? 'image/png' : 'image/jpeg';
      const blob = await new Promise<Blob>((resolve, reject) => out.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось обработать фото.')), type, 0.92));
      const name = file.name.replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg');
      uri = URL.createObjectURL(blob);
      await onReady({ uri, name, mimeType: type, size: blob.size, file: new File([blob], name, { type }) });
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обработать фото.'); }
    finally { if (uri) URL.revokeObjectURL(uri); setBusy(false); }
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); if (tool) setTool(null); else onCancel(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const bar = 'rgba(28,30,36,0.94)';
  const ToolButton = ({ icon, label, active, onPress, disabled }: { icon: IconName; label: string; active?: boolean; onPress: () => void; disabled?: boolean }) =>
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active, disabled }}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ alignItems: 'center', gap: 3, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, opacity: disabled ? 0.35 : 1, backgroundColor: active ? 'rgba(10,132,255,0.22)' : hovered ? 'rgba(255,255,255,0.08)' : 'transparent' })}>
      <Icon name={icon} size={20} color={active ? '#4DA3FF' : '#FFFFFF'} /><Text style={{ color: active ? '#4DA3FF' : '#D8DCE4', fontSize: 11 }}>{label}</Text>
    </Pressable>;

  const c = state.crop;
  return <Modal visible transparent onRequestClose={onCancel}>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center' }}>
      <View style={{ height: 56, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
        <Pressable onPress={onCancel} accessibilityRole="button" style={{ paddingHorizontal: 12, paddingVertical: 8 }}><Text style={{ color: '#D8DCE4', fontSize: 15 }}>Отмена</Text></Pressable>
        <Text style={{ flex: 1, textAlign: 'center', color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{tool === 'crop' ? 'Обрезка' : tool === 'draw' ? 'Рисование' : 'Редактор фото'}</Text>
        <Pressable onPress={() => void save()} disabled={!bitmap || busy} accessibilityRole="button" style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: t.accent, opacity: !bitmap || busy ? 0.5 : 1 }}><Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{busy ? 'Сохраняем…' : edited ? 'Готово' : 'Добавить'}</Text></Pressable>
      </View>
      <View style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
        {error ? <Text style={{ color: '#FF8A80', fontSize: 14, textAlign: 'center', maxWidth: 420 }}>{error}</Text> : !view ? <Text style={{ color: '#9AA3B2' }}>Открываем фото…</Text> :
          <div ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            style={{ position: 'relative', width: view.w, height: view.h, touchAction: 'none', cursor: tool === 'draw' ? 'crosshair' : tool === 'crop' ? 'move' : 'default', userSelect: 'none' }}>
            <canvas ref={canvas} style={{ width: view.w, height: view.h, display: 'block', borderRadius: 4 }} />
            {(tool === 'crop' || c.w < 0.999 || c.h < 0.999) ? <>
              {/* Shade outside the crop frame */}
              {[{ left: 0, top: 0, width: '100%', height: `${c.y * 100}%` }, { left: 0, top: `${(c.y + c.h) * 100}%`, width: '100%', height: `${(1 - c.y - c.h) * 100}%` }, { left: 0, top: `${c.y * 100}%`, width: `${c.x * 100}%`, height: `${c.h * 100}%` }, { left: `${(c.x + c.w) * 100}%`, top: `${c.y * 100}%`, width: `${(1 - c.x - c.w) * 100}%`, height: `${c.h * 100}%` }]
                .map((s, i) => <div key={i} style={{ position: 'absolute', background: 'rgba(0,0,0,0.55)', pointerEvents: 'none', ...s }} />)}
              <div style={{ position: 'absolute', left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%`, border: '1.5px solid #FFFFFF', boxSizing: 'border-box', pointerEvents: 'none',
                backgroundImage: tool === 'crop' ? 'linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)' : undefined, backgroundSize: '33.33% 33.33%', backgroundPosition: '-1px -1px' }}>
                {tool === 'crop' ? ['nw', 'ne', 'sw', 'se'].map(k => <div key={k} style={{ position: 'absolute', width: 14, height: 14, background: '#FFFFFF', borderRadius: 3, left: k[1] === 'w' ? -7 : undefined, right: k[1] === 'e' ? -7 : undefined, top: k[0] === 'n' ? -7 : undefined, bottom: k[0] === 's' ? -7 : undefined }} />) : null}
              </div>
            </> : null}
          </div>}
      </View>
      {/* Options row for the active tool */}
      <View style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 }}>
        {tool === 'crop' ? ASPECTS.map(a => <Pressable key={a.label} onPress={() => pickAspect(a.value)} accessibilityRole="radio" accessibilityState={{ checked: aspect === a.value }}
          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: aspect === a.value ? 'rgba(10,132,255,0.28)' : 'rgba(255,255,255,0.08)' }}><Text style={{ color: aspect === a.value ? '#4DA3FF' : '#D8DCE4', fontSize: 12, fontWeight: '600' }}>{a.label}</Text></Pressable>) : null}
        {tool === 'draw' ? <>
          {COLORS.map(col => <Pressable key={col} onPress={() => setColor(col)} accessibilityRole="radio" accessibilityLabel={`Цвет ${col}`} accessibilityState={{ checked: color === col }}
            style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: col, borderWidth: color === col ? 3 : 1, borderColor: color === col ? '#4DA3FF' : 'rgba(255,255,255,0.4)' }} />)}
          <View style={{ width: 12 }} />
          {[0.006, 0.012, 0.024].map(size => <Pressable key={size} onPress={() => setPenSize(size)} accessibilityRole="radio" accessibilityLabel={`Толщина ${size}`} accessibilityState={{ checked: penSize === size }}
            style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: penSize === size ? 'rgba(10,132,255,0.28)' : 'transparent' }}><View style={{ width: size * 900, height: size * 900, borderRadius: size * 450, backgroundColor: '#FFFFFF' }} /></Pressable>)}
        </> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, marginBottom: 18, borderRadius: 16, backgroundColor: bar }}>
        <ToolButton icon="crop-outline" label="Обрезать" active={tool === 'crop'} disabled={!bitmap} onPress={() => setTool(tool === 'crop' ? null : 'crop')} />
        <ToolButton icon="refresh-outline" label="Повернуть" disabled={!bitmap} onPress={rotate} />
        <ToolButton icon="swap-horizontal-outline" label="Отразить" disabled={!bitmap} onPress={flip} />
        <ToolButton icon="brush-outline" label="Рисовать" active={tool === 'draw'} disabled={!bitmap} onPress={() => setTool(tool === 'draw' ? null : 'draw')} />
        <View style={{ width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.15)', marginHorizontal: 4 }} />
        <ToolButton icon="arrow-undo-outline" label="Отменить" disabled={!history.current.length} onPress={undo} />
        <ToolButton icon="sync-outline" label="Сброс" disabled={!edited} onPress={reset} />
      </View>
    </View>
  </Modal>;
}
