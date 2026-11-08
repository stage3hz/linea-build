// Full-screen photo with live geometry: the rotated photo sits in a clipping window of the crop size, pen lines
// and the object-removal mask are SVG paths on top. Rotation, mirror, crop and strokes never wait for a render.
import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Defs, Path, Pattern, Rect as SvgRect } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { PhotoStroke } from '../../../modules/linea-photo';
import {
  cropDrag, hitCrop, mapPoint, orientedSize, previewLayout, viewportToSource,
  type Crop, type CropHandle, type Point, type PreviewLayout, type Size,
} from '../geometry.ts';
import { appendBrushPoint } from '../editorModel';
import { drawingBudget, strokeBudget, withCrop, withDrawing, withStroke, type Drawing, type EditState } from '../editorHistory.ts';

export type CanvasTool = 'crop' | 'draw' | 'remove' | 'view';

type Props = {
  sourceUri: string; displayUri: string; source: Size; state: EditState; tool: CanvasTool;
  penColor: string; penWidth: number; brushRadius: number; aspect: number | null; transparent: boolean; hdr: boolean;
  showMask: boolean; disabled: boolean;
  onPreview: (next: EditState) => void; onCommit: (next: EditState) => void; onLimit: (message: string) => void;
};

function pathOf(points: Point[], layout: PreviewLayout, state: EditState): string {
  const box = layout.rotated;
  const screen = points.map(point => { const p = mapPoint(point, state.rotation, state.flip); return { x: p.x * box.width, y: p.y * box.height }; });
  if (!screen.length) return '';
  const [first, ...rest] = screen;
  // A dot is a tiny segment so the round cap draws it.
  return `M${first.x.toFixed(2)} ${first.y.toFixed(2)}` + (rest.length ? rest.map(p => `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('') : `L${(first.x + .01).toFixed(2)} ${first.y.toFixed(2)}`);
}

/** Shows transparency behind a photo without background. */
function Checkerboard() {
  return <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
    <Defs><Pattern id="checker" width="20" height="20" patternUnits="userSpaceOnUse">
      <SvgRect width="20" height="20" fill="#E3E6EB" /><SvgRect width="10" height="10" fill="#F8F9FC" /><SvgRect x="10" y="10" width="10" height="10" fill="#F8F9FC" />
    </Pattern></Defs>
    <SvgRect x="0" y="0" width="100%" height="100%" fill="url(#checker)" />
  </Svg>;
}

export function EditorCanvas(current: Props) {
  // Gesture callbacks run on the JS thread and always read the latest props.
  const latest = useRef(current); latest.current = current;
  const { source, state, tool } = current;
  const props = current;
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Point[] | null>(null);
  const drag = useRef<{ handle: CropHandle; start: Point; crop?: Crop; last?: EditState } | null>(null);
  const points = useRef<Point[]>([]);
  const transform = { rotation: state.rotation, flip: state.flip };
  // While cropping, the whole rotated photo is visible and the frame is drawn over it.
  const cropping = tool === 'crop';
  const layout = useMemo(() => previewLayout(source, transform, cropping ? undefined : state.crop, viewport),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.width, source.height, state.rotation, state.flip, cropping, state.crop, viewport.width, viewport.height]);
  const unit = layout ? Math.min(layout.rotated.width, layout.rotated.height) : 0;

  const layoutRef = useRef(layout); layoutRef.current = layout;
  const drawing = useRef(false);
  const toSource = (x: number, y: number) => { const l = layoutRef.current, s = latest.current.state; return l ? viewportToSource({ x, y }, l, { rotation: s.rotation, flip: s.flip }) : null; };
  const toRotated = (x: number, y: number): Point | null => { const l = layoutRef.current; return l ? { x: (x - l.window.x) / l.window.width, y: (y - l.window.y) / l.window.height } : null; };

  const begin = (x: number, y: number) => {
    const props = latest.current, { state, tool } = props, layout = layoutRef.current;
    if (!layout || props.disabled) return;
    if (tool === 'crop') {
      const p = toRotated(x, y); if (!p) return;
      drag.current = { handle: hitCrop(p, state.crop, { x: 28 / layout.window.width, y: 28 / layout.window.height }), start: p, crop: state.crop };
      return;
    }
    if (tool === 'draw' || tool === 'remove') {
      const full = tool === 'draw' ? drawingBudget(state) <= 0 : strokeBudget(state) <= 0 || state.strokes.length >= 64;
      if (full) { props.onLimit(tool === 'draw' ? 'Слишком много линий. Отмени часть рисунка.' : 'Маска слишком сложная. Отмени часть мазков.'); return; }
      const p = toSource(x, y); points.current = p ? [p] : []; drawing.current = true; setDraft(points.current);
    }
  };
  const move = (x: number, y: number) => {
    const props = latest.current, { state, tool } = props;
    if (!layoutRef.current) return;
    if (tool === 'crop' && drag.current) {
      const p = toRotated(x, y); if (!p) return;
      const next = cropDrag(drag.current.handle, drag.current.start, p, drag.current.crop, props.aspect, orientedSize(props.source, state.rotation));
      if (next) { const preview = withCrop(state, next); drag.current.last = preview; props.onPreview(preview); }
      return;
    }
    if ((tool === 'draw' || tool === 'remove') && drawing.current) {
      const p = toSource(x, y); if (!p) return;
      const size = tool === 'draw' ? props.penWidth / 2 : props.brushRadius;
      const budget = tool === 'draw' ? drawingBudget(state) : strokeBudget(state);
      const next = appendBrushPoint(points.current, p, Math.max(size, .004), budget);
      if (next !== points.current) { points.current = next; setDraft(next); }
    }
  };
  const end = () => {
    const props = latest.current, { state, tool } = props;
    drawing.current = false;
    // The frame is one history step, taken when the finger is lifted.
    // The last computed frame is committed even if its preview has not been rendered yet; a tap commits nothing.
    if (tool === 'crop' && drag.current) { const last = drag.current.last; drag.current = null; if (last) props.onCommit(last); return; }
    if ((tool === 'draw' || tool === 'remove') && points.current.length) {
      const line = points.current; points.current = []; setDraft(null);
      // Each stroke is one history step.
      if (tool === 'draw') props.onCommit(withDrawing(state, { color: props.penColor, width: props.penWidth, points: line } as Drawing));
      else props.onCommit(withStroke(state, { radius: props.brushRadius, points: line } as PhotoStroke));
      return;
    }
    points.current = []; setDraft(null);
  };

  const gesture = Gesture.Pan().runOnJS(true).minDistance(0).maxPointers(1)
    .enabled(tool !== 'view' && !props.disabled)
    .onBegin(event => begin(event.x, event.y))
    .onUpdate(event => move(event.x, event.y))
    .onFinalize(() => end());

  const onLayout = (event: LayoutChangeEvent) => setViewport({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  const crop = state.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const label = tool === 'draw' ? 'Фото. Проведи пальцем, чтобы рисовать' : tool === 'remove' ? 'Фото. Закрась объект, который нужно убрать' : tool === 'crop' ? 'Фото. Перетащи рамку или её углы, чтобы обрезать' : 'Редактируемое фото';

  return <GestureDetector gesture={gesture}>
    <View style={{ flex: 1 }} onLayout={onLayout} accessible accessibilityLabel={label}>
      {layout ? <View pointerEvents="none" style={{ position: 'absolute', left: layout.window.x, top: layout.window.y, width: layout.window.width, height: layout.window.height, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: layout.rotated.x, top: layout.rotated.y, width: layout.rotated.width, height: layout.rotated.height }}>
          {props.transparent ? <Checkerboard /> : null}
          <Image source={{ uri: props.displayUri }} contentFit="fill" preferHighDynamicRange={props.hdr && props.displayUri === props.sourceUri} transition={0}
            style={{ position: 'absolute', left: layout.image.x, top: layout.image.y, width: layout.image.width, height: layout.image.height, transform: [{ scaleX: layout.scaleX }, { rotate: `${layout.rotation}deg` }] }} />
          <Svg style={StyleSheet.absoluteFill}>
            {props.showMask || draft && tool === 'remove' ? [...state.strokes, ...(draft && tool === 'remove' ? [{ radius: props.brushRadius, points: draft }] : [])].map((stroke, index) =>
              <Path key={`m${index}`} d={pathOf(stroke.points, layout, state)} stroke="rgba(234,55,122,0.5)" strokeWidth={2 * stroke.radius * unit} strokeLinecap="round" strokeLinejoin="round" fill="none" />) : null}
            {[...state.drawings, ...(draft && tool === 'draw' ? [{ color: props.penColor, width: props.penWidth, points: draft }] : [])].map((drawing, index) =>
              <Path key={`d${index}`} d={pathOf(drawing.points, layout, state)} stroke={drawing.color} strokeWidth={drawing.width * unit} strokeLinecap="round" strokeLinejoin="round" fill="none" />)}
          </Svg>
        </View>
        {cropping ? <View style={StyleSheet.absoluteFill}>
          {[
            { left: 0, top: 0, width: '100%', height: `${crop.y * 100}%` },
            { left: 0, top: `${(crop.y + crop.height) * 100}%`, width: '100%', bottom: 0 },
            { left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` },
            { left: `${(crop.x + crop.width) * 100}%`, top: `${crop.y * 100}%`, right: 0, height: `${crop.height * 100}%` },
          ].map((shade, index) => <View key={index} style={[{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' }, shade as object]} />)}
          <View style={{ position: 'absolute', left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`, borderWidth: 1.5, borderColor: '#FFFFFF' }}>
            {[1, 2].map(third => <React.Fragment key={third}>
              <View style={{ position: 'absolute', left: `${third * 100 / 3}%`, top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.55)' }} />
              <View style={{ position: 'absolute', top: `${third * 100 / 3}%`, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.55)' }} />
            </React.Fragment>)}
            {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <View key={corner} style={{ position: 'absolute', width: 22, height: 22, borderColor: '#FFFFFF',
              borderTopWidth: corner[0] === 'n' ? 4 : 0, borderBottomWidth: corner[0] === 's' ? 4 : 0, borderLeftWidth: corner[1] === 'w' ? 4 : 0, borderRightWidth: corner[1] === 'e' ? 4 : 0,
              left: corner[1] === 'w' ? -3 : undefined, right: corner[1] === 'e' ? -3 : undefined, top: corner[0] === 'n' ? -3 : undefined, bottom: corner[0] === 's' ? -3 : undefined }} />)}
          </View>
        </View> : null}
      </View> : null}
    </View>
  </GestureDetector>;
}
