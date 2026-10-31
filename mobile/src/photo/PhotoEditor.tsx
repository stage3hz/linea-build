import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { Text } from '../typography';
import type { PhotoCapabilities, PhotoCrop, PhotoInfo, PhotoOptions, PhotoStroke } from '../../modules/linea-photo';
import type { LocalFile } from '../types';
import { Button, Icon, InsetView, IconButton, Notice, SectionLabel } from '../components';
import { GlassStage, GlassSurface } from '../glass';
import { formatSize, useTheme } from '../theme';
import { getPhotoCapabilities, inspectPhoto, preparePhotoBackground, renderPhoto, type PreparedPhoto } from './pipeline';
import { appendBrushPoint, boundedPoint, centeredCrop, containRect, cropFromDrag, cropPixelBounds, normalizedPoint, photoSizePlan, type Point, type Rect, type Size } from './editorModel';
import { PreviewSession } from './PreviewSession';

const defaults = (): PhotoOptions => ({ background: 'keep', document: 'none', format: 'png', resolution: 1, scale: 1, strokes: [], allowDownsample: false });
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось обработать фото. Попробуй ещё раз.';
const dimensions = (size: Size) => `${size.width} × ${size.height}`;
const MAX_BRUSH_POINTS = 1024;

function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} onPress={onPress} disabled={disabled}
    style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 17, borderWidth: 1, borderColor: selected ? t.accent : t.border, backgroundColor: selected ? t.accentSoft : t.surface2, opacity: disabled ? .4 : pressed ? .75 : 1 })}>
    <Text style={{ color: selected ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <GlassSurface radius={24} shadow={false} contentStyle={{ padding: 17, gap: 12 }}><SectionLabel>{title}</SectionLabel>{children}</GlassSurface>;
}

function Checkerboard({ width, height }: Size) {
  const cols = Math.ceil(width / 20), rows = Math.ceil(height / 20);
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden', backgroundColor: '#E3E6EB' }]}>
    {Array.from({ length: cols * rows }, (_, index) => {
      const row = Math.floor(index / cols), column = index % cols;
      return (row + column) % 2 ? <View key={index} style={{ position: 'absolute', left: column * 20, top: row * 20, width: 20, height: 20, backgroundColor: '#F8F9FC' }} /> : null;
    })}
  </View>;
}

function BrushMask({ rect, strokes }: { rect: Rect | null; strokes: PhotoStroke[] }) {
  if (!rect) return null;
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    {strokes.flatMap((stroke, s) => stroke.points.map((point, p) => {
      const previous = stroke.points[Math.max(0, p - 1)];
      const x = rect.x + point.x * rect.width, y = rect.y + point.y * rect.height;
      const px = rect.x + previous.x * rect.width, py = rect.y + previous.y * rect.height;
      const diameter = 2 * stroke.radius * Math.min(rect.width, rect.height);
      return <View key={`${s}:${p}`} style={{ position: 'absolute', left: (x + px) / 2 - (Math.hypot(x - px, y - py) + diameter) / 2, top: (y + py) / 2 - diameter / 2, width: Math.hypot(x - px, y - py) + diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: 'rgba(234,55,122,0.45)', transform: [{ rotate: `${Math.atan2(y - py, x - px)}rad` }] }} />;
    }))}
  </View>;
}

function CropMask({ rect, crop }: { rect: Rect | null; crop?: PhotoCrop | null }) {
  if (!rect || !crop) return null;
  const left = crop.x * rect.width, top = crop.y * rect.height, width = crop.width * rect.width, height = crop.height * rect.height;
  return <View pointerEvents="none" style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
    {[
      { left: 0, top: 0, width: rect.width, height: top },
      { left: 0, top: top + height, width: rect.width, height: rect.height - top - height },
      { left: 0, top, width: left, height },
      { left: left + width, top, width: rect.width - left - width, height },
    ].map((shade, index) => <View key={index} style={{ position: 'absolute', ...shade, backgroundColor: 'rgba(0,0,0,.48)' }} />)}
    <View style={{ position: 'absolute', left, top, width, height, borderWidth: 2, borderColor: '#FFF' }}>
      {[1, 2].map(third => <React.Fragment key={third}><View style={{ position: 'absolute', left: `${third * 100 / 3}%`, top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,.55)' }} /><View style={{ position: 'absolute', top: `${third * 100 / 3}%`, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,.55)' }} /></React.Fragment>)}
    </View>
  </View>;
}

function PhotoCanvas({ uri, size, height, crop, cropMode, strokes, radius, paint, disabled, onStroke, onCrop, onDrawing, onError }: {
  uri: string; size: Size; height: number; crop?: PhotoCrop; cropMode: boolean; strokes: PhotoStroke[]; radius: number; paint: boolean; disabled: boolean;
  onStroke: (stroke: PhotoStroke) => void; onCrop: (crop: PhotoCrop) => void; onDrawing: (drawing: boolean) => void; onError: (message: string) => void;
}) {
  const [width, setWidth] = useState(0), [points, setPoints] = useState<Point[]>([]);
  const [cropDraft, setCropDraft] = useState<PhotoCrop | null>(null);
  const pending = useRef<Point[]>([]), isDrawing = useRef(false);
  const cropStart = useRef<Point | null>(null), pendingCrop = useRef<PhotoCrop | null>(null);
  const bounds = cropPixelBounds(size, cropMode ? undefined : crop);
  const rect = containRect(bounds, { width, height });
  const budget = MAX_BRUSH_POINTS - strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  const add = (event: GestureResponderEvent) => {
    const point = normalizedPoint({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, rect);
    if (!point) return;
    const next = appendBrushPoint(pending.current, point, radius, budget);
    pending.current = next;
    setPoints(next);
  };
  const begin = (event: GestureResponderEvent) => {
    if (cropMode) {
      const point = normalizedPoint({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, rect);
      if (!point) return;
      cropStart.current = point;
      pendingCrop.current = null;
      isDrawing.current = true;
      onDrawing(true);
      return;
    }
    if (strokes.length >= 64 || budget <= 0) { onError('Маска слишком сложная. Отмени часть мазков или сбрось её.'); return; }
    isDrawing.current = true;
    pending.current = [];
    onDrawing(true);
    add(event);
  };
  const move = (event: GestureResponderEvent) => {
    if (!isDrawing.current) return;
    if (!cropMode) { add(event); return; }
    const point = boundedPoint({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, rect);
    if (!point || !cropStart.current) return;
    pendingCrop.current = cropFromDrag(cropStart.current, point);
    setCropDraft(pendingCrop.current);
  };
  const finish = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    if (cropMode) {
      if (pendingCrop.current) onCrop(pendingCrop.current);
      pendingCrop.current = null;
      cropStart.current = null;
      setCropDraft(null);
    } else if (pending.current.length) onStroke({ radius, points: pending.current });
    pending.current = [];
    setPoints([]);
    onDrawing(false);
  };
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height, borderRadius: 22, overflow: 'hidden', width: '100%' }}>
    <Checkerboard width={width} height={height} />
    {rect ? <View pointerEvents="none" style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, overflow: 'hidden' }}>
      <Image source={{ uri }} resizeMode="stretch" style={{ position: 'absolute', left: -bounds.x * rect.width / bounds.width, top: -bounds.y * rect.height / bounds.height, width: size.width * rect.width / bounds.width, height: size.height * rect.height / bounds.height }} accessibilityLabel="Предпросмотр фотографии" onError={() => onError('Не удалось показать изображение. Проверь результат после обработки.')} />
    </View> : null}
    <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => (paint || cropMode) && !disabled} onMoveShouldSetResponder={() => (paint || cropMode) && !disabled}
      onResponderGrant={begin} onResponderMove={move} onResponderRelease={finish} onResponderTerminate={finish} onResponderTerminationRequest={() => false}>
      {paint ? <BrushMask rect={rect} strokes={points.length ? [...strokes, { radius, points }] : strokes} /> : null}
      {cropMode ? <CropMask rect={rect} crop={cropDraft || crop || { x: 0, y: 0, width: 1, height: 1 }} /> : null}
    </View>
  </View>;
}

function ReductionConsent({ source, plan, allowed, disabled, onChange }: { source: Size; plan: ReturnType<typeof photoSizePlan>; allowed: boolean; disabled: boolean; onChange: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: allowed, disabled }} disabled={disabled} onPress={onChange}
    style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 15, borderRadius: 19, borderWidth: 1, borderColor: allowed ? t.accent : t.border, backgroundColor: t.accentSoft }}>
    <Icon name={allowed ? 'checkbox' : 'square-outline'} color={t.accent} size={24} />
    <View style={{ flex: 1, gap: 5 }}><Text style={{ color: t.text, fontWeight: '600', fontSize: 13 }}>Разрешить уменьшение при превышении лимита</Text>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Исходник: {dimensions(source)}. Предварительно с выбранным кадром и размером: обработка {plan.baseWidth} × {plan.baseHeight}, результат {dimensions(plan)}. Если файл окажется больше 20 МБ, может понадобиться дополнительное уменьшение. Оно применяется только с этим согласием. Финальные размеры будут в предпросмотре.</Text>
    </View>
  </Pressable>;
}

export function PhotoEditor({ file, onCancel, onReady }: { file: LocalFile; onCancel: () => void; onReady: (file: LocalFile) => Promise<void> }) {
  const t = useTheme(), window = useWindowDimensions();
  const [caps, setCaps] = useState<PhotoCapabilities | null>(null), [info, setInfo] = useState<PhotoInfo | null>(null);
  const [options, setOptions] = useState<PhotoOptions>(defaults), [result, setResult] = useState<PreparedPhoto | null>(null);
  const [phase, setPhase] = useState<'loading' | 'rendering' | 'model' | 'sending' | null>('loading');
  const [error, setError] = useState(''), [showOriginal, setShowOriginal] = useState(true);
  const [paint, setPaint] = useState(false), [cropMode, setCropMode] = useState(false), [drawing, setDrawing] = useState(false), [radius, setRadius] = useState(.02);
  const [reload, setReload] = useState(0);
  const sessionRef = useRef(new PreviewSession<PreparedPhoto>()), busyRef = useRef(true), drawingRef = useRef(false);
  const optionsRef = useRef<PhotoOptions>(options);
  const plan = useMemo(() => caps && info ? photoSizePlan(info, options, caps) : null, [caps, info, options]);
  const needsConsent = !!plan?.downsampled && !options.allowDownsample;
  const cropBounds = info ? cropPixelBounds(info, options.crop) : null;
  const cropSourceTooLarge = !!info && !!cropBounds && !!caps && info.width * info.height > caps.maxPlainPixels && (cropBounds.width !== info.width || cropBounds.height !== info.height);
  const working = phase !== null, hdrBlocked = !!info && info.dynamicRange !== 'sdr', locked = working || drawing || hdrBlocked;
  const backgroundReady = options.background === 'keep' || !!caps?.backgroundReady;

  async function generate(session: PreviewSession<PreparedPhoto>, selected: PhotoOptions) {
    const revision = session.revision;
    busyRef.current = true;
    setPhase('rendering');
    setError('');
    try {
      const output = await renderPhoto(file, selected);
      if (session.accept(revision, output)) { setResult(output); setShowOriginal(false); setPaint(false); setCropMode(false); setError(''); }
    } catch (failure) {
      if (session.isCurrent(revision)) setError(errorText(failure));
    } finally {
      if (!session.isClosed) { busyRef.current = false; setPhase(null); }
    }
  }

  useEffect(() => {
    const session = new PreviewSession<PreparedPhoto>();
    sessionRef.current = session;
    const initial = defaults();
    optionsRef.current = initial;
    setCaps(null);
    setInfo(null);
    setOptions(initial);
    setResult(null);
    setError('');
    setShowOriginal(true);
    setPaint(false);
    setCropMode(false);
    setDrawing(false);
    drawingRef.current = false;
    setPhase('loading');
    busyRef.current = true;
    void Promise.all([getPhotoCapabilities(), inspectPhoto(file.uri)]).then(async ([capabilities, metadata]) => {
      if (session.isClosed) return;
      setCaps(capabilities);
      setInfo(metadata);
      if (metadata.dynamicRange !== 'sdr' || photoSizePlan(metadata, initial, capabilities).downsampled) {
        busyRef.current = false;
        setPhase(null);
        return;
      }
      await generate(session, initial);
    }).catch(failure => {
      if (!session.isClosed) { setError(errorText(failure)); busyRef.current = false; setPhase(null); }
    });
    return () => session.close();
  }, [file.uri, reload]);

  function change(next: PhotoOptions) {
    if (busyRef.current) return;
    sessionRef.current.revise();
    optionsRef.current = next;
    setOptions(next);
    setResult(null);
    setShowOriginal(true);
    setError('');
  }

  async function prepareBackground() {
    if (busyRef.current) return;
    const session = sessionRef.current;
    busyRef.current = true;
    setPhase('model');
    setError('');
    try {
      await preparePhotoBackground();
      const next = await getPhotoCapabilities();
      if (!session.isClosed) setCaps(next);
    } catch (failure) { if (!session.isClosed) setError(errorText(failure)); }
    finally { if (!session.isClosed) { busyRef.current = false; setPhase(null); } }
  }

  async function submit() {
    if (busyRef.current || drawingRef.current) return;
    const session = sessionRef.current;
    const lease = session.acquire();
    if (!lease) { setError('Сначала примени выбранные настройки и проверь результат.'); return; }
    busyRef.current = true;
    setPhase('sending');
    setError('');
    try { await onReady(lease.value.file); if (!session.isClosed) onCancel(); }
    catch (failure) { if (!session.isClosed) setError(errorText(failure)); }
    finally {
      lease.release();
      if (!session.isClosed) { busyRef.current = false; setPhase(null); }
    }
  }

  const cancel = () => { if (phase !== 'sending') onCancel(); };
  const isSource = paint || cropMode || showOriginal || !result;
  const displayed = isSource ? file.uri : result.file.uri;
  const displayedSize = !isSource && result ? result : info;
  const format = options.format === 'jpeg' ? 'JPEG' : 'PNG';
  const setCrop = (crop?: PhotoCrop) => { change({ ...optionsRef.current, crop, strokes: [] }); setPaint(false); };
  const status = phase === 'loading' ? 'Открываем фото…' : phase === 'rendering' ? 'Обрабатываем на устройстве…' : phase === 'model' ? 'Подготавливаем удаление фона…' : 'Шифруем и добавляем в сообщение…';
  const helpStyle = { color: t.muted, fontSize: 12, lineHeight: 18 };
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={cancel}>
    <GlassStage><InsetView style={{ flex: 1 }}>
      <GlassSurface lens radius={25} style={{ margin: 12, marginBottom: 6 }} contentStyle={{ padding: 8, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <IconButton name="close" label="Отменить редактирование фото" onPress={cancel} disabled={phase === 'sending'} />
        <View style={{ flex: 1, gap: 3 }}><Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Фото перед отправкой</Text><Text style={{ color: t.muted, fontSize: 11 }}>Очистка метаданных перед отправкой</Text></View>
        <Icon name="shield-checkmark-outline" color={t.accent} size={22} />
      </GlassSurface>
      <ScrollView scrollEnabled={!drawing} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 12, paddingBottom: 28, gap: 13, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 7 }}>
            <Choice label="До эффектов" selected={isSource} disabled={working || drawing} onPress={() => { setShowOriginal(true); setPaint(false); setCropMode(false); }} />
            <Choice label="Результат" selected={!isSource} disabled={!result || locked} onPress={() => { setShowOriginal(false); setPaint(false); setCropMode(false); }} />
          </View>
          {displayedSize ? <Text style={[helpStyle, { fontSize: 10 }]}>{dimensions(isSource && !cropMode ? cropPixelBounds(displayedSize, options.crop) : displayedSize)}</Text> : null}
        </View>
        {displayedSize ? <PhotoCanvas uri={displayed} size={displayedSize} crop={isSource ? options.crop : undefined} cropMode={cropMode} height={Math.max(220, Math.min(window.height * .4, 420))} strokes={options.strokes} radius={radius} paint={paint} disabled={working || hdrBlocked}
          onDrawing={value => { drawingRef.current = value; setDrawing(value); }} onCrop={setCrop} onError={setError} onStroke={stroke => change({ ...optionsRef.current, strokes: [...optionsRef.current.strokes, stroke] })} /> : <View style={{ minHeight: 180, justifyContent: 'center', alignItems: 'center' }}><Icon name="image-outline" size={44} color={t.subtle} /></View>}
        {cropMode ? <Text style={[helpStyle, { textAlign: 'center' }]}>Проведи пальцем по фото, чтобы задать новый прямоугольный кадр.</Text> : null}
        {working ? <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 9, alignItems: 'center', padding: 7 }}><ActivityIndicator color={t.accent} /><Text style={helpStyle}>{status}</Text></View> : null}
        {error ? <Notice text={error} error /> : null}
        {error && (!caps || !info) ? <Button secondary label="Попробовать открыть снова" disabled={working} onPress={() => setReload(value => value + 1)} /> : null}
        {hdrBlocked ? <Notice text={`${info?.dynamicRange === 'hdr' ? 'Это фото HDR.' : 'Не удалось надёжно определить динамический диапазон фото.'} ${info?.dynamicRangeReason || caps?.hdrReason || 'Этот редактор пока не сохраняет HDR.'} Фото не будет автоматически превращено в SDR.`} error /> : null}
        {result ? <Text style={[helpStyle, { textAlign: 'center' }]}>{dimensions(result)} · {result.file.mimeType === 'image/jpeg' ? 'JPEG' : 'PNG'}{typeof result.file.size === 'number' ? ` · ${formatSize(result.file.size)}` : ''}{result.downsampled ? ' · дополнительно уменьшено с твоего согласия' : ''}</Text> : null}
        {caps && info ? <>
          <Panel title="Кадрирование">
            <Button secondary icon="crop-outline" label={cropMode ? 'Завершить кадрирование' : 'Выбрать область на фото'} disabled={locked} onPress={() => { setCropMode(!cropMode); setPaint(false); setShowOriginal(true); }} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Choice label="Весь кадр" selected={!options.crop} disabled={locked} onPress={() => setCrop()} />
              {[{ label: '1 : 1', aspect: 1 }, { label: '4 : 3', aspect: 4 / 3 }, { label: '16 : 9', aspect: 16 / 9 }].map(preset => <Choice key={preset.label} label={preset.label} selected={false} disabled={locked} onPress={() => { setCrop(centeredCrop(info, preset.aspect)); setCropMode(true); setShowOriginal(true); }} />)}
            </View>
            <Text style={helpStyle}>{options.crop ? `Кадр: ${dimensions(cropPixelBounds(info, options.crop))}. ` : ''}Изменение кадра очищает маску удаления объектов. Сначала выбери кадр, затем рисуй кистью.</Text>
            {cropSourceTooLarge ? <Text style={{ color: t.danger, fontSize: 12, lineHeight: 18 }}>Точная обрезка доступна для исходников до 16 Мп. Сначала подготовь уменьшенную копию без обрезки и открой её снова. Выбор 50% после обрезки не обходит этот предел.</Text> : null}
          </Panel>
          <Panel title="Формат">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Choice label="PNG" selected={options.format !== 'jpeg'} disabled={locked} onPress={() => change({ ...options, format: 'png' })} />
              <Choice label="JPEG" selected={options.format === 'jpeg'} disabled={locked || options.background === 'transparent'} onPress={() => change({ ...options, format: 'jpeg' })} />
            </View>
            <Text style={helpStyle}>PNG сохраняет прозрачность. JPEG сжимает с потерями и не поддерживает прозрачный фон. EXIF, GPS и личные метаданные удаляются перед отправкой.</Text>
          </Panel>
          <Panel title="Фон">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Choice label="Исходный" selected={options.background === 'keep'} disabled={locked} onPress={() => change({ ...options, background: 'keep' })} />
              <Choice label="Без фона · PNG" selected={options.background === 'transparent'} disabled={locked || !caps.backgroundRemoval || !caps.backgroundReady} onPress={() => change({ ...options, format: 'png', background: 'transparent', document: 'none' })} />
              <Choice label="Белый" selected={options.background === 'white'} disabled={locked || !caps.backgroundRemoval || !caps.backgroundReady} onPress={() => change({ ...options, background: 'white', document: 'none' })} />
            </View>
            {!caps.backgroundRemoval ? <Text style={helpStyle}>{caps.backgroundReason || 'Удаление фона недоступно на этом устройстве.'}</Text> : !caps.backgroundReady ? <>
              <Text style={helpStyle}>{caps.backgroundReason || 'Для первого использования нужно загрузить модель. Само фото обрабатывается на устройстве.'}</Text>
              <Button secondary label="Подготовить удаление фона" onPress={() => void prepareBackground()} disabled={locked} loading={phase === 'model'} />
            </> : <Text style={helpStyle}>Шахматный фон показывает прозрачность. Проверь волосы, края и полупрозрачные участки.</Text>}
            {Platform.OS === 'android' ? <Text style={helpStyle}>Удаление фона использует Google ML Kit: фото и результат не передаются Google. SDK может загружать модели и обновления и отправляет технические метрики использования и производительности.</Text> : null}
          </Panel>
          <Panel title="Документ">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Choice label="Фото" selected={options.document === 'none'} disabled={locked} onPress={() => change({ ...options, document: 'none' })} />
              <Choice label="Ч/б документ" selected={options.document === 'bw'} disabled={locked} onPress={() => change({ ...options, document: 'bw', background: 'keep' })} />
              <Choice label="Цветной" selected={options.document === 'color'} disabled={locked} onPress={() => change({ ...options, document: 'color', background: 'keep' })} />
            </View>
            <Text style={helpStyle}>Выравнивает освещение и подавляет тени на бумаге. Проверь мелкий текст, подписи и печати в результате.</Text>
          </Panel>
          <Panel title="Размер">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Choice label="Полное" selected={options.resolution !== .5} disabled={locked} onPress={() => change({ ...options, resolution: 1 })} />
              <Choice label="50%" selected={options.resolution === .5} disabled={locked} onPress={() => change({ ...options, resolution: .5 })} />
            </View>
            <Text style={helpStyle}>50% — половина ширины и половина высоты выбранного кадра, то есть четверть его пикселей. Увеличение применяется после этого выбора.</Text>
          </Panel>
          <Panel title="Увеличение">
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Choice label="×1" selected={options.scale === 1} disabled={locked} onPress={() => change({ ...options, scale: 1 })} />
              <Choice label="×2" selected={options.scale === 2} disabled={locked} onPress={() => change({ ...options, scale: 2 })} />
              <Choice label="×4" selected={options.scale === 4} disabled={locked} onPress={() => change({ ...options, scale: 4 })} />
            </View>
            <Text style={helpStyle}>Бикубическое увеличение. Оно добавляет пиксели интерполяцией и не восстанавливает утраченные детали.</Text>
          </Panel>
          <Panel title="Удалить небольшой объект">
            <Button secondary label={paint ? 'Закончить выделение' : 'Выделить кистью'} icon="brush-outline" disabled={locked} onPress={() => { setPaint(!paint); setCropMode(false); setShowOriginal(true); }} />
            <Text style={helpStyle}>Закрась объект в выбранном кадре. Выделенная область заполняется соседними цветами; сложная текстура может размыться. Маска — до 20% кадра.</Text>
            {options.strokes.length ? <Text style={helpStyle}>Мазков в маске: {options.strokes.length}. Для удаления объекта нажми «Применить и посмотреть».</Text> : null}
            {paint ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {([{ label: 'Тонкая', value: .008 }, { label: 'Средняя', value: .02 }, { label: 'Широкая', value: .05 }] as const).map(brush => <Choice key={brush.value} label={brush.label} selected={radius === brush.value} disabled={locked} onPress={() => setRadius(brush.value)} />)}
            </View> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Choice label="Отменить мазок" selected={false} disabled={locked || !options.strokes.length} onPress={() => change({ ...options, strokes: options.strokes.slice(0, -1) })} />
              <Choice label="Сбросить маску" selected={false} disabled={locked || !options.strokes.length} onPress={() => change({ ...options, strokes: [] })} />
            </View>
          </Panel>
          {plan ? <ReductionConsent source={info} plan={plan} allowed={!!options.allowDownsample} disabled={locked} onChange={() => change({ ...options, allowDownsample: !options.allowDownsample })} /> : null}
          <Button secondary icon="refresh-outline" label="Сбросить все настройки" disabled={locked} onPress={() => { change(defaults()); setPaint(false); setCropMode(false); }} />
          <Button secondary icon="sparkles-outline" label={result ? 'Применить снова' : 'Применить и посмотреть'} loading={phase === 'rendering'} disabled={locked || needsConsent || !backgroundReady || cropSourceTooLarge} onPress={() => { if (!busyRef.current) void generate(sessionRef.current, optionsRef.current); }} />
          <Button icon="checkmark-outline" label={`Добавить ${format} к сообщению`} loading={phase === 'sending'} disabled={locked || !result} onPress={() => void submit()} />
          <Text style={[helpStyle, { textAlign: 'center' }]}>После подтверждения фото шифруется перед загрузкой. Исходник в галерее остаётся прежним. HDR не преобразуется в SDR автоматически; редактирование HDR в этой версии пока недоступно.</Text>
        </> : null}
      </ScrollView>
    </InsetView></GlassStage>
  </Modal>;
}
