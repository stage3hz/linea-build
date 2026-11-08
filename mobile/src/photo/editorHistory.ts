// Pure editor state and undo/redo history (no React, no native modules), shared by the
// mobile editor and the desktop editor. Every finished gesture is one `commit`; a frame
// being dragged is a `preview` that does not enter the history until its `commit`.
import type { PhotoCrop, PhotoDrawing, PhotoOptions, PhotoStroke } from '../../modules/linea-photo';
import {
  clipPolyline, flipCrop, isFullCrop, rotateCropLeft, rotateLeft, sourceLengthToOutput, sourceToOutput,
  type Point, type Rotation, type Size, type Transform,
} from './geometry.ts';

/** Strokes and drawings are normalized to the oriented source; the crop to the rotated frame. */
export type Drawing = PhotoDrawing;
export type EditState = {
  background: PhotoOptions['background'];
  document: PhotoOptions['document'];
  scale: PhotoOptions['scale'];
  format: 'png' | 'jpeg';
  resolution: 1 | 0.5;
  allowDownsample: boolean;
  dynamicRange: 'keep' | 'sdr';
  crop?: PhotoCrop;
  rotation: Rotation;
  flip: boolean;
  strokes: PhotoStroke[];
  drawings: Drawing[];
};
export type History = { past: EditState[]; present: EditState; future: EditState[]; anchor?: EditState };
export type Action =
  | { type: 'commit'; next: EditState }
  | { type: 'preview'; next: EditState }
  | { type: 'cancelPreview' }
  | { type: 'undo' } | { type: 'redo' } | { type: 'reset'; initial?: EditState };

export const HISTORY_LIMIT = 50;
export const MAX_STROKES = 64, MAX_STROKE_POINTS = 1024;
export const MAX_DRAWINGS = 128, MAX_DRAWING_POINTS = 4096;
/** Pen colours, the same set as the desktop editor (Telegram-like). */
export const PEN_COLORS = ['#FFFFFF', '#111111', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#AF52DE'] as const;
export const PEN_WIDTHS = [{ label: 'Тонкая', value: 0.006 }, { label: 'Средняя', value: 0.012 }, { label: 'Широкая', value: 0.024 }] as const;
export const BRUSH_RADII = [{ label: 'Тонкая', value: 0.008 }, { label: 'Средняя', value: 0.02 }, { label: 'Широкая', value: 0.05 }] as const;

export function initialEditState(format: 'png' | 'jpeg' = 'png'): EditState {
  return { background: 'keep', document: 'none', scale: 1, format, resolution: 1, allowDownsample: false, dynamicRange: 'keep', rotation: 0, flip: false, strokes: [], drawings: [] };
}

export function createHistory(initial: EditState = initialEditState()): History {
  return { past: [], present: initial, future: [] };
}

const settled = (history: History) => history.anchor ?? history.present;

export function reduce(history: History, action: Action): History {
  switch (action.type) {
    case 'preview':
      return { ...history, anchor: settled(history), present: action.next };
    case 'cancelPreview':
      return history.anchor ? { past: history.past, present: history.anchor, future: history.future } : history;
    case 'commit': {
      const base = settled(history);
      // An edit that ends where it started (a frame dragged back) is not a step.
      if (action.next === base || sameEdit(action.next, base)) return { past: history.past, present: base, future: history.future };
      return { past: [...history.past, base].slice(-HISTORY_LIMIT), present: action.next, future: [] };
    }
    case 'undo': {
      const base = settled(history);
      if (!history.past.length) return { past: history.past, present: base, future: history.future };
      return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1], future: [base, ...history.future] };
    }
    case 'redo': {
      const base = settled(history);
      if (!history.future.length) return { past: history.past, present: base, future: history.future };
      return { past: [...history.past, base].slice(-HISTORY_LIMIT), present: history.future[0], future: history.future.slice(1) };
    }
    case 'reset': {
      const initial = action.initial ?? initialEditState(settled(history).format);
      // Reset keeps the explicit SDR consent: it is a property of the file, not an edit.
      const next = { ...initial, dynamicRange: settled(history).dynamicRange };
      return sameEdit(settled(history), next) ? { past: history.past, present: settled(history), future: history.future } : reduce(history, { type: 'commit', next });
    }
  }
}

export const canUndo = (history: History) => history.past.length > 0;
export const canRedo = (history: History) => history.future.length > 0;

const canonical = (s: EditState) => JSON.stringify([s.background, s.document, s.scale, s.format, s.resolution, s.allowDownsample, s.dynamicRange,
  isFullCrop(s.crop) ? null : [s.crop!.x, s.crop!.y, s.crop!.width, s.crop!.height], s.rotation, s.flip,
  s.strokes.map(stroke => [stroke.radius, stroke.points.map(p => [p.x, p.y])]), s.drawings.map(d => [d.color, d.width, d.points.map(p => [p.x, p.y])])]);

export function sameEdit(a: EditState, b: EditState): boolean {
  return a === b || canonical(a) === canonical(b);
}

/** Nothing that changes the pixels was chosen: the plain upload path applies. */
/** `initialFormat`: the format the editor started with; choosing another one (e.g. PNG for an HDR JPEG) is an edit. */
export function isUnedited(state: EditState, initialFormat?: 'png' | 'jpeg'): boolean {
  return (initialFormat === undefined || state.format === initialFormat) && state.background === 'keep' && state.document === 'none' && state.scale === 1 && state.resolution === 1 && state.rotation === 0 && !state.flip
    && isFullCrop(state.crop) && !state.strokes.length && !state.drawings.length;
}

// ---- Edits (each returns a new state; the caller commits it) ----

export function rotated(state: EditState): EditState {
  const transform = rotateLeft(state);
  return { ...state, ...transform, crop: rotateCropLeft(state.crop) };
}

export function flipped(state: EditState): EditState {
  return { ...state, flip: !state.flip, crop: flipCrop(state.crop) };
}

export function withCrop(state: EditState, crop: PhotoCrop | undefined): EditState {
  return { ...state, crop: crop && !isFullCrop(crop) ? { ...crop } : undefined };
}

const copyPoints = (points: Point[]) => points.map(point => ({ x: point.x, y: point.y }));

export function strokeBudget(state: EditState): number {
  return MAX_STROKE_POINTS - state.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
}

export function drawingBudget(state: EditState): number {
  return MAX_DRAWING_POINTS - state.drawings.reduce((sum, drawing) => sum + drawing.points.length, 0);
}

export function withStroke(state: EditState, stroke: PhotoStroke): EditState {
  if (!stroke.points.length || state.strokes.length >= MAX_STROKES || strokeBudget(state) < stroke.points.length) return state;
  return { ...state, strokes: [...state.strokes, { radius: stroke.radius, points: copyPoints(stroke.points) }] };
}

export function withDrawing(state: EditState, drawing: Drawing): EditState {
  if (!drawing.points.length || state.drawings.length >= MAX_DRAWINGS || drawingBudget(state) < drawing.points.length) return state;
  return { ...state, drawings: [...state.drawings, { color: drawing.color, width: drawing.width, points: copyPoints(drawing.points) }] };
}

/** Choosing a mode that cannot carry HDR is the explicit, labelled consent to SDR. */
export function losesHdr(state: Pick<EditState, 'background' | 'document' | 'format'>): boolean {
  return state.background === 'transparent' || state.document !== 'none' || state.format === 'png';
}

// ---- Render options ----

export type EffectKey = string;

/** Effects that need the native renderer, independent of geometry: the preview cache key. */
export function effectKey(state: EditState): EffectKey {
  return JSON.stringify({ b: state.background, d: state.document, s: state.strokes });
}

export function hasEffects(state: EditState): boolean {
  return state.background !== 'keep' || state.document !== 'none' || state.strokes.length > 0;
}

function outputLines<T extends { points: Point[] }>(items: T[], size: (item: T) => number, rebuild: (item: T, points: Point[], size: number) => T, source: Size, transform: Transform, crop?: PhotoCrop): T[] {
  const result: T[] = [];
  for (const item of items) {
    const width = Math.min(2, sourceLengthToOutput(size(item), source, transform, crop));
    const points = item.points.map(point => sourceToOutput(point, source, transform, crop));
    for (const run of clipPolyline(points, width + 0.01)) result.push(rebuild(item, run, width));
  }
  return result;
}

/** The final render request: geometry, effects and drawings, mapped into the native output frame. */
export function renderOptions(state: EditState, source: Size, sdr = false): PhotoOptions {
  const transform = { rotation: state.rotation, flip: state.flip }, crop = isFullCrop(state.crop) ? undefined : state.crop;
  const strokes = outputLines(state.strokes, stroke => stroke.radius, (_, points, radius) => ({ radius: Math.max(0.0005, radius), points }), source, transform, crop);
  const drawings = outputLines(state.drawings, drawing => drawing.width, (drawing, points, width) => ({ color: drawing.color, width: Math.max(0.0005, width), points }), source, transform, crop);
  return {
    background: state.background, document: state.document, scale: state.scale, strokes,
    allowDownsample: state.allowDownsample, format: state.format, resolution: state.resolution,
    ...(crop ? { crop: { ...crop } } : {}),
    ...(state.rotation ? { rotation: state.rotation } : {}),
    ...(state.flip ? { flip: true } : {}),
    ...(drawings.length ? { drawings } : {}),
    ...(sdr || state.dynamicRange === 'sdr' ? { dynamicRange: 'sdr' as const } : {}),
  };
}

/** The deferred on-screen preview of the expensive effects: no geometry, no drawings, small and SDR. */
export function previewOptions(state: EditState, maxPixels: number): PhotoOptions {
  return {
    background: state.background, document: state.document, scale: 1,
    strokes: state.strokes.map(stroke => ({ radius: stroke.radius, points: copyPoints(stroke.points) })),
    allowDownsample: true, format: state.background === 'transparent' ? 'png' : 'jpeg', resolution: 1,
    dynamicRange: 'sdr', preview: { maxPixels: Math.max(65_536, Math.min(2_000_000, Math.round(maxPixels))) },
  };
}
