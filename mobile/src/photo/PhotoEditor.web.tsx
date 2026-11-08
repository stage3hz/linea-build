// Compact photo editor for the PC app (Telegram Desktop-like): the photo in the middle, a thin toolbar under
// it. Crop (free / 1:1 / 4:3 / 3:4 / 16:9, drag the frame or its corners), rotate 90°, flip, draw with a pen,
// undo / redo. The state, geometry and history are the shared modules of the mobile editor (editorHistory.ts,
// geometry.ts), so both editors cut and rotate exactly like the native renderer.
// Saving re-encodes the picture in the browser, which drops EXIF/GPS metadata. A JPEG with a gain map keeps
// its HDR: the base and the map are edited with the same geometry on two canvases and the container is rebuilt
// by the HDR gate; if that is impossible, the user is asked before saving without HDR.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import { Icon, type IconName } from '../components';
import { useTheme } from '../theme';
import type { LocalFile } from '../types';
import {
  canRedo, canUndo, createHistory, drawingBudget, flipped, initialEditState, isUnedited, reduce, rotated, withCrop, withDrawing, PEN_COLORS, PEN_WIDTHS,
  type Action, type EditState, type History,
} from './editorHistory.ts';
import { centeredAspectCrop, cropDrag, cropPixelBounds, hitCrop, isFullCrop, mapPoint, orientedSize, unmapPoint, type CropHandle, type Point, type Size } from './geometry.ts';
import { assembleGainmapJpeg, announcesGainmap, neutralGain, splitGainmapJpeg, type GainmapParts } from './jpegHdr.ts';

type Tool = 'crop' | 'draw' | null;
const ASPECTS: { label: string; value: number | null }[] = [{ label: 'Свободно', value: null }, { label: '1:1', value: 1 }, { label: '4:3', value: 4 / 3 }, { label: '3:4', value: 3 / 4 }, { label: '16:9', value: 16 / 9 }];
const COLOR_NAMES = ['белый', 'чёрный', 'красный', 'оранжевый', 'жёлтый', 'зелёный', 'синий', 'фиолетовый'];
const MAX_SIDE = 4096;

/** Draws the photo rotated clockwise, then mirrored, into a canvas of the rotated size. */
function drawBase(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, state: Pick<EditState, 'rotation' | 'flip'>, width: number, height: number) {
  ctx.save();
  ctx.translate(width / 2, height / 2);
  // Canvas transforms apply to the content in reverse order: rotate first, then mirror.
  if (state.flip) ctx.scale(-1, 1);
  ctx.rotate(state.rotation * Math.PI / 180);
  const w = state.rotation % 180 ? height : width, h = state.rotation % 180 ? width : height;
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}
/** Pen lines (stored in source coordinates) on a canvas of the rotated frame. `extra` widens them (map pixels). */
function drawLines(ctx: CanvasRenderingContext2D, state: EditState, width: number, height: number, color?: string, extra = 0) {
  const unit = Math.min(width, height);
  for (const line of state.drawings) {
    if (!line.points.length) continue;
    const points = line.points.map(p => mapPoint(p, state.rotation, state.flip));
    ctx.strokeStyle = color ?? line.color; ctx.lineWidth = line.width * unit + extra; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(points[0].x * width, points[0].y * height);
    for (const p of points.slice(1)) ctx.lineTo(p.x * width, p.y * height);
    if (points.length === 1) ctx.lineTo(points[0].x * width + 0.01, points[0].y * height);
    ctx.stroke();
  }
}
const blobOf = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось обработать фото.')), type, 0.95));

/** Renders one image (base or gain map) with the editor's geometry: full rotated frame, crop, size limit. */
function renderFrame(bitmap: ImageBitmap, state: EditState, out: Size, background: string | null, lines?: { color?: string; extra: number }): HTMLCanvasElement {
  const rotated = orientedSize({ width: bitmap.width, height: bitmap.height }, state.rotation);
  const full = document.createElement('canvas'); full.width = rotated.width; full.height = rotated.height;
  const fctx = full.getContext('2d'); if (!fctx) throw new Error('Не удалось обработать фото.');
  drawBase(fctx, bitmap, state, rotated.width, rotated.height);
  if (lines) drawLines(fctx, state, rotated.width, rotated.height, lines.color, lines.extra);
  const crop = cropPixelBounds(rotated, isFullCrop(state.crop) ? undefined : state.crop);
  const canvas = document.createElement('canvas'); canvas.width = out.width; canvas.height = out.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Не удалось обработать фото.');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, out.width, out.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
  return canvas;
}

export function PhotoEditor({ file, onCancel, onReady }: { file: LocalFile; onCancel: () => void; onReady: (file: LocalFile) => Promise<void> }) {
  const t = useTheme(); const win = useWindowDimensions();
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [gainmap, setGainmap] = useState<{ parts: GainmapParts; map: ImageBitmap } | null>(null);
  const [hdrAnnounced, setHdrAnnounced] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>(null); const [aspect, setAspect] = useState<number | null>(null);
  const [color, setColor] = useState<string>(PEN_COLORS[2]); const [penSize, setPenSize] = useState<number>(PEN_WIDTHS[1].value);
  const [history, setHistory] = useState<History>(() => createHistory(initialEditState('jpeg')));
  const state = history.present;
  const dispatch = useCallback((action: Action) => setHistory(current => reduce(current, action)), []);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ kind: CropHandle | 'draw'; start: Point; points: Point[] } | null>(null);
  const [draft, setDraft] = useState<Point[] | null>(null);
  // «Сохранить без HDR?» — our own dialog: Cancel is the default (Enter/Escape), unlike window.confirm.
  const [sdrAsk, setSdrAsk] = useState<((ok: boolean) => void) | null>(null);
  const askSdr = () => new Promise<boolean>(resolve => setSdrAsk(() => (ok: boolean) => { setSdrAsk(null); resolve(ok); }));
  const TOO_MANY = 'Слишком много линий. Отмени часть рисунка.';

  useEffect(() => {
    let alive = true; const made: ImageBitmap[] = [];
    (async () => {
      try {
        const blob = file.file || await (await fetch(file.uri)).blob();
        const base = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions); made.push(base);
        if (!alive) return;
        setBitmap(base);
        // A gain-map JPEG: keep its two images to edit HDR with the same geometry.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (announcesGainmap(bytes)) {
          if (alive) setHdrAnnounced(true);
          try {
            const parts = splitGainmapJpeg(bytes);
            const map = await createImageBitmap(new Blob([parts.map as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } as ImageBitmapOptions); made.push(map);
            if (alive) setGainmap({ parts, map });
          } catch { /* SDR, or HDR the gate cannot rebuild: asked at saving time. */ }
        }
      } catch { if (alive) setError('Этот формат фото нельзя открыть в редакторе. Его можно отправить без изменений.'); }
    })();
    return () => { alive = false; made.forEach(item => item.close()); };
  }, [file]);

  const rotatedSize = useMemo(() => bitmap ? orientedSize({ width: bitmap.width, height: bitmap.height }, state.rotation) : null, [bitmap, state.rotation]);
  // Fit the rotated photo into the free area (toolbar 150 px, top bar 56 px).
  const view = useMemo(() => {
    if (!rotatedSize) return null;
    const maxW = Math.max(200, Math.min(win.width - 48, 1100)), maxH = Math.max(160, win.height - 56 - 150);
    const scale = Math.min(maxW / rotatedSize.width, maxH / rotatedSize.height);
    return { w: Math.round(rotatedSize.width * scale), h: Math.round(rotatedSize.height * scale) };
  }, [rotatedSize, win.width, win.height]);
  const hdrSource = hdrAnnounced || !!gainmap;

  // Paint the preview: the whole rotated photo and the drawings; the crop is a frame over it.
  useEffect(() => {
    const c = canvas.current; if (!c || !bitmap || !view) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = Math.round(view.w * ratio); c.height = Math.round(view.h * ratio);
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    drawBase(ctx, bitmap, state, c.width, c.height);
    drawLines(ctx, draft ? withDrawing(state, { color, width: penSize, points: draft }) : state, c.width, c.height);
  }, [bitmap, view, state, draft, color, penSize]);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!tool || !stage.current || !rotatedSize) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = point(e);
    if (tool === 'draw') {
      if (drawingBudget(state) <= 0) { setError(TOO_MANY); return; }
      const source = unmapPoint(p, state.rotation, state.flip); drag.current = { kind: 'draw', start: p, points: [source] }; setDraft([source]); return;
    }
    drag.current = { kind: hitCrop(p, state.crop, { x: .04, y: .04 }), start: p, points: [] };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || !rotatedSize) return;
    const p = point(e);
    if (d.kind === 'draw') {
      if (d.points.length < Math.min(4000, drawingBudget(state))) { d.points = [...d.points, unmapPoint(p, state.rotation, state.flip)]; setDraft(d.points); }
      else setError(TOO_MANY);
      return;
    }
    const anchor = history.anchor ?? history.present;
    const next = cropDrag(d.kind, d.start, p, anchor.crop, aspect, rotatedSize);
    if (next) dispatch({ type: 'preview', next: withCrop(anchor, next) });
  };
  const onUp = () => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    // A stroke and a finished frame drag are one step each.
    if (d.kind === 'draw') {
      setDraft(null);
      const next = withDrawing(state, { color, width: penSize, points: d.points });
      // Never drop a stroke silently.
      if (next === state) setError(TOO_MANY); else dispatch({ type: 'commit', next });
    }
    else dispatch({ type: 'commit', next: state });
  };

  const pickAspect = (value: number | null) => {
    setAspect(value);
    if (value && rotatedSize) dispatch({ type: 'commit', next: withCrop(state, centeredAspectCrop(rotatedSize, value)) });
  };
  const edited = !isUnedited(state, 'jpeg');

  /** Output size: the crop of the rotated photo, at most 4096 px on the long side. */
  const outputSize = (source: Size): Size => {
    const crop = cropPixelBounds(orientedSize(source, state.rotation), isFullCrop(state.crop) ? undefined : state.crop);
    const scale = Math.min(1, MAX_SIDE / Math.max(crop.width, crop.height));
    return { width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)) };
  };

  /** HDR: base and gain map with the same geometry; pen lines neutral on the map; container rebuilt by the gate. */
  const saveHdr = async (): Promise<Blob> => {
    if (!bitmap || !gainmap) throw new Error('Нет карты яркости.');
    const out = outputSize({ width: bitmap.width, height: bitmap.height });
    const base = renderFrame(bitmap, state, out, '#FFFFFF', { extra: 0 });
    const scaleX = gainmap.map.width / bitmap.width, scaleY = gainmap.map.height / bitmap.height;
    const turned = state.rotation % 180 !== 0;
    const mapOut = { width: Math.max(1, Math.round(out.width * (turned ? scaleY : scaleX))), height: Math.max(1, Math.round(out.height * (turned ? scaleX : scaleY))) };
    const neutral = neutralGain(gainmap.parts.metadata), grey = `rgb(${neutral[0]},${neutral[1] ?? neutral[0]},${neutral[2] ?? neutral[0]})`;
    const map = renderFrame(gainmap.map, state, mapOut, null, { color: grey, extra: 2 });
    const [baseBytes, mapBytes] = await Promise.all([blobOf(base, 'image/jpeg'), blobOf(map, 'image/jpeg')].map(async blob => new Uint8Array(await (await blob).arrayBuffer())));
    // The canvas encodes sRGB: the source ICC no longer applies, so none is attached.
    const clean = assembleGainmapJpeg({ base: baseBytes, map: mapBytes, metadata: gainmap.parts.metadata });
    return new Blob([clean.bytes as BlobPart], { type: 'image/jpeg' });
  };

  const saveSdr = async (png: boolean): Promise<Blob> => {
    if (!bitmap) throw new Error('Не удалось обработать фото.');
    const out = renderFrame(bitmap, state, outputSize({ width: bitmap.width, height: bitmap.height }), png ? null : '#FFFFFF', { extra: 0 });
    return blobOf(out, png ? 'image/png' : 'image/jpeg');
  };

  const save = async () => {
    if (!bitmap || busy) return;
    setBusy(true); setError(''); let uri = '';
    try {
      // Nothing changed: the original goes through the normal upload cleaning (HDR passthrough included).
      if (!edited) { await onReady(file); return; }
      const png = /png|webp|gif/i.test(file.mimeType);
      let blob: Blob | null = null;
      if (hdrSource && !png) {
        try { blob = await saveHdr(); }
        catch { if (!await askSdr()) return; }
      }
      blob = blob ?? await saveSdr(png);
      const type = blob.type || (png ? 'image/png' : 'image/jpeg');
      const name = file.name.replace(/\.[^.]+$/, '') + (type === 'image/png' ? '.png' : '.jpg');
      uri = URL.createObjectURL(blob);
      await onReady({ uri, name, mimeType: type, size: blob.size, file: new File([blob], name, { type }) });
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обработать фото.'); }
    finally { if (uri) URL.revokeObjectURL(uri); setBusy(false); }
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (sdrAsk) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); sdrAsk(false); } return; }
      if (e.key === 'Escape') { e.preventDefault(); if (tool) setTool(null); else onCancel(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); dispatch({ type: 'redo' }); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: 'undo' }); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  const bar = 'rgba(28,30,36,0.94)';
  const ToolButton = ({ icon, label, active, onPress, disabled, hint }: { icon: IconName; label: string; active?: boolean; onPress: () => void; disabled?: boolean; hint?: string }) =>
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={hint ?? label} accessibilityState={{ selected: !!active, disabled }}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ alignItems: 'center', gap: 3, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, opacity: disabled ? 0.35 : 1, backgroundColor: active ? 'rgba(10,132,255,0.22)' : hovered ? 'rgba(255,255,255,0.08)' : 'transparent' })}>
      <Icon name={icon} size={20} color={active ? '#4DA3FF' : '#FFFFFF'} /><Text style={{ color: active ? '#4DA3FF' : '#D8DCE4', fontSize: 11 }}>{label}</Text>
    </Pressable>;

  const c = state.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return <Modal visible transparent onRequestClose={onCancel}>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center' }}>
      <View style={{ height: 56, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
        <Pressable onPress={onCancel} accessibilityRole="button" style={{ paddingHorizontal: 12, paddingVertical: 8 }}><Text style={{ color: '#D8DCE4', fontSize: 15 }}>Отмена</Text></Pressable>
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{tool === 'crop' ? 'Обрезка' : tool === 'draw' ? 'Рисование' : 'Редактор фото'}</Text>
          {hdrSource ? <View accessibilityLabel={gainmap ? 'HDR сохранится' : 'HDR может не сохраниться'} style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, borderWidth: 1, borderColor: gainmap ? '#FFD60A' : '#9AA3B2' }}><Text style={{ color: gainmap ? '#FFD60A' : '#9AA3B2', fontSize: 11, fontWeight: '800' }}>{gainmap ? 'HDR' : 'SDR'}</Text></View> : null}
        </View>
        <Pressable onPress={() => void save()} disabled={!bitmap || busy} accessibilityRole="button" style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: t.accent, opacity: !bitmap || busy ? 0.5 : 1 }}><Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{busy ? 'Сохраняем…' : edited ? 'Готово' : 'Добавить'}</Text></Pressable>
      </View>
      <View style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
        {error && !view ? <Text style={{ color: '#FF8A80', fontSize: 14, textAlign: 'center', maxWidth: 420 }}>{error}</Text> : !view ? <Text style={{ color: '#9AA3B2' }}>Открываем фото…</Text> :
          <div ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            style={{ position: 'relative', width: view.w, height: view.h, touchAction: 'none', cursor: tool === 'draw' ? 'crosshair' : tool === 'crop' ? 'move' : 'default', userSelect: 'none' }}>
            <canvas ref={canvas} style={{ width: view.w, height: view.h, display: 'block', borderRadius: 4 }} />
            {(tool === 'crop' || !isFullCrop(state.crop)) ? <>
              {[{ left: 0, top: 0, width: '100%', height: `${c.y * 100}%` }, { left: 0, top: `${(c.y + c.height) * 100}%`, width: '100%', height: `${(1 - c.y - c.height) * 100}%` }, { left: 0, top: `${c.y * 100}%`, width: `${c.x * 100}%`, height: `${c.height * 100}%` }, { left: `${(c.x + c.width) * 100}%`, top: `${c.y * 100}%`, width: `${(1 - c.x - c.width) * 100}%`, height: `${c.height * 100}%` }]
                .map((s, i) => <div key={i} style={{ position: 'absolute', background: 'rgba(0,0,0,0.55)', pointerEvents: 'none', ...s }} />)}
              <div style={{ position: 'absolute', left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.width * 100}%`, height: `${c.height * 100}%`, border: '1.5px solid #FFFFFF', boxSizing: 'border-box', pointerEvents: 'none',
                backgroundImage: tool === 'crop' ? 'linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)' : undefined, backgroundSize: '33.33% 33.33%', backgroundPosition: '-1px -1px' }}>
                {tool === 'crop' ? ['nw', 'ne', 'sw', 'se'].map(k => <div key={k} style={{ position: 'absolute', width: 14, height: 14, background: '#FFFFFF', borderRadius: 3, left: k[1] === 'w' ? -7 : undefined, right: k[1] === 'e' ? -7 : undefined, top: k[0] === 'n' ? -7 : undefined, bottom: k[0] === 's' ? -7 : undefined }} />) : null}
              </div>
            </> : null}
          </div>}
        {error && view ? <Text style={{ color: '#FF8A80', fontSize: 13, textAlign: 'center', marginTop: 8 }}>{error}</Text> : null}
      </View>
      <View style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 }}>
        {tool === 'crop' ? ASPECTS.map(a => <Pressable key={a.label} onPress={() => pickAspect(a.value)} accessibilityRole="radio" accessibilityState={{ checked: aspect === a.value }}
          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: aspect === a.value ? 'rgba(10,132,255,0.28)' : 'rgba(255,255,255,0.08)' }}><Text style={{ color: aspect === a.value ? '#4DA3FF' : '#D8DCE4', fontSize: 12, fontWeight: '600' }}>{a.label}</Text></Pressable>) : null}
        {tool === 'draw' ? <>
          {PEN_COLORS.map((col, index) => <Pressable key={col} onPress={() => setColor(col)} accessibilityRole="radio" accessibilityLabel={`Цвет: ${COLOR_NAMES[index]}`} accessibilityState={{ checked: color === col }}
            style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: col, borderWidth: color === col ? 3 : 1, borderColor: color === col ? '#4DA3FF' : 'rgba(255,255,255,0.4)' }} />)}
          <View style={{ width: 12 }} />
          {PEN_WIDTHS.map(size => <Pressable key={size.value} onPress={() => setPenSize(size.value)} accessibilityRole="radio" accessibilityLabel={`Толщина: ${size.label.toLowerCase()}`} accessibilityState={{ checked: penSize === size.value }}
            style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: penSize === size.value ? 'rgba(10,132,255,0.28)' : 'transparent' }}><View style={{ width: size.value * 900, height: size.value * 900, borderRadius: size.value * 450, backgroundColor: '#FFFFFF' }} /></Pressable>)}
        </> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 6, marginBottom: 18, borderRadius: 16, backgroundColor: bar }}>
        <ToolButton icon="crop-outline" label="Обрезать" active={tool === 'crop'} disabled={!bitmap} onPress={() => setTool(tool === 'crop' ? null : 'crop')} />
        <ToolButton icon="refresh-outline" label="Повернуть" hint="Повернуть на 90°" disabled={!bitmap} onPress={() => dispatch({ type: 'commit', next: rotated(state) })} />
        <ToolButton icon="swap-horizontal-outline" label="Отразить" disabled={!bitmap} onPress={() => dispatch({ type: 'commit', next: flipped(state) })} />
        <ToolButton icon="brush-outline" label="Рисовать" active={tool === 'draw'} disabled={!bitmap} onPress={() => setTool(tool === 'draw' ? null : 'draw')} />
        <View style={{ width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.15)', marginHorizontal: 4 }} />
        <ToolButton icon="arrow-undo-outline" label="Отменить" hint="Отменить действие" disabled={!canUndo(history)} onPress={() => dispatch({ type: 'undo' })} />
        <ToolButton icon="arrow-redo-outline" label="Повторить" hint="Повторить действие" disabled={!canRedo(history)} onPress={() => dispatch({ type: 'redo' })} />
        <ToolButton icon="sync-outline" label="Сброс" hint="Сбросить все изменения" disabled={!edited} onPress={() => { setAspect(null); dispatch({ type: 'reset' }); }} />
      </View>
      {sdrAsk ? <View accessibilityRole="alert" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 380, maxWidth: '90%', padding: 20, gap: 14, borderRadius: 16, backgroundColor: '#1C1E24' }}>
          <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700' }}>Сохранить без HDR?</Text>
          <Text style={{ color: '#D8DCE4', fontSize: 14, lineHeight: 20 }}>HDR этого фото не удаётся сохранить при редактировании на ПК. Его можно сохранить с обычной яркостью.</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <Pressable onPress={() => sdrAsk(true)} accessibilityRole="button" style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}><Text style={{ color: '#D8DCE4', fontSize: 14 }}>Сохранить без HDR</Text></Pressable>
            <Pressable onPress={() => sdrAsk(false)} accessibilityRole="button" accessibilityLabel="Отмена, оставить фото без изменений" style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: t.accent }}><Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '700' }}>Отмена</Text></Pressable>
          </View>
        </View>
      </View> : null}
    </View>
  </Modal>;
}
