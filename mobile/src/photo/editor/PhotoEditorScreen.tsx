// Telegram-like photo editor: the photo fills the screen, every change is visible at once, ↶ ↷ undo and redo
// any step, and «Отправить» renders the final file directly (no separate «apply» step).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, PixelRatio, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Text } from '../../typography';
import { Icon, IconButton } from '../../components';
import type { PhotoCapabilities, PhotoInfo } from '../../../modules/linea-photo';
import type { LocalFile } from '../../types';
import { getPhotoCapabilities, inspectPhoto, preparePhotoBackground, renderPhoto, type PreparedPhoto } from '../pipeline';
import { allowSdr, isHdrConsentError } from '../hdrConsent';
import { photoSizePlan } from '../editorModel';
import { centeredAspectCrop, orientedSize, isFullCrop } from '../geometry.ts';
import {
  canRedo, canUndo, createHistory, flipped, initialEditState, isUnedited, losesHdr, reduce, renderOptions, rotated, sameEdit, withCrop,
  PEN_COLORS, PEN_WIDTHS, BRUSH_RADII, type Action, type EditState, type History,
} from '../editorHistory.ts';
import { EditorCanvas, type CanvasTool } from './EditorCanvas';
import { TabBar, ToolPanel, type EditorTab } from './EditorPanels';
import { useEffectPreview } from './useEffectPreview';
import { nativeErrorMessage } from '../../media/nativeError';

const errorText = (error: unknown) => nativeErrorMessage(error, 'Не удалось обработать фото. Попробуй ещё раз.');
const ask = (title: string, message: string, confirm: string) => new Promise<boolean>(resolve =>
  Alert.alert(title, message, [{ text: 'Отмена', style: 'cancel', onPress: () => resolve(false) }, { text: confirm, onPress: () => resolve(true) }], { cancelable: true, onDismiss: () => resolve(false) }));
const TOOL: Record<EditorTab, CanvasTool> = { crop: 'crop', draw: 'draw', remove: 'remove', background: 'view', enhance: 'view', size: 'view' };

export function PhotoEditor({ file, onCancel, onReady }: { file: LocalFile; onCancel: () => void; onReady: (file: LocalFile) => Promise<void> }) {
  const window = useWindowDimensions(), insets = useSafeAreaInsets();
  const [caps, setCaps] = useState<PhotoCapabilities | null>(null), [info, setInfo] = useState<PhotoInfo | null>(null);
  const [history, setHistory] = useState<History>(() => createHistory());
  const [initial, setInitial] = useState<EditState>(() => initialEditState());
  const [tab, setTab] = useState<EditorTab>('crop'), [aspect, setAspect] = useState<number | null>(null);
  const [penColor, setPenColor] = useState<string>(PEN_COLORS[2]), [penWidth, setPenWidth] = useState<number>(PEN_WIDTHS[1].value), [brushRadius, setBrushRadius] = useState<number>(BRUSH_RADII[1].value);
  const [phase, setPhase] = useState<'loading' | 'sending' | 'model' | null>('loading');
  const [error, setError] = useState(''), [reload, setReload] = useState(0);
  const alive = useRef(true), historyRef = useRef(history);
  historyRef.current = history;
  const present = history.present;
  const dispatch = (action: Action) => setHistory(current => { const next = reduce(current, action); historyRef.current = next; return next; });

  useEffect(() => {
    alive.current = true;
    setPhase('loading'); setError(''); setCaps(null); setInfo(null);
    void Promise.all([getPhotoCapabilities(), inspectPhoto(file.uri)]).then(([capabilities, metadata]) => {
      if (!alive.current) return;
      // A gain-map photo defaults to JPEG, the only format that carries HDR; others keep lossless PNG.
      const start = initialEditState(metadata.dynamicRange === 'hdr' && metadata.hdrKind === 'gainmap' ? 'jpeg' : 'png');
      setCaps(capabilities); setInfo(metadata); setInitial(start); setHistory(createHistory(start)); setPhase(null);
    }).catch(failure => { if (alive.current) { setError(errorText(failure)); setPhase(null); } });
    return () => { alive.current = false; };
  }, [file.uri, reload]);

  const hdrSource = !!info && info.dynamicRange !== 'sdr';
  const preservable = !!info && info.dynamicRange === 'hdr' && info.hdrKind === 'gainmap' && !!info.hdrPreservable && !!caps?.hdrPreservation;
  const sdrNow = present.dynamicRange === 'sdr' || losesHdr(present);
  const busy = phase !== null;
  const maxPixels = Math.min(2_000_000, window.width * window.height * PixelRatio.get() ** 2);
  const effect = useEffectPreview(file, info ? present : null, maxPixels, !!info && phase !== 'loading');

  const plan = useMemo(() => caps && info ? photoSizePlan(info, renderOptions(present, info), caps) : null, [caps, info, present]);
  const cropSourceTooLarge = !!info && !!caps && !isFullCrop(present.crop) && info.width * info.height > caps.maxPlainPixels;

  /** Every committed change goes through here; a photo whose HDR cannot be kept asks once (that answer is a step too). */
  function commit(next: EditState) {
    const base = historyRef.current.anchor ?? historyRef.current.present;
    // A frame dragged back to where it started is not a step.
    if (sameEdit(next, base)) { if (historyRef.current.anchor) dispatch({ type: 'cancelPreview' }); return; }
    if (hdrSource && !preservable && next.dynamicRange !== 'sdr' && !isUnedited(next, initial.format) && !losesHdr(next)) {
      void ask('HDR не сохранится', 'HDR на этом устройстве не сохраняется при редактировании. Продолжить как обычное фото?', 'Продолжить без HDR').then(ok => {
        if (!alive.current) return;
        dispatch(ok ? { type: 'commit', next: { ...next, dynamicRange: 'sdr' } } : { type: 'cancelPreview' });
      });
      return;
    }
    dispatch({ type: 'commit', next });
  }

  function pickAspect(value: number | null) {
    setAspect(value);
    if (value && info) commit(withCrop(present, centeredAspectCrop(orientedSize(info, present.rotation), value)));
  }

  async function prepareBackground() {
    if (busy) return;
    setPhase('model'); setError('');
    try { await preparePhotoBackground(); const next = await getPhotoCapabilities(); if (alive.current) setCaps(next); }
    catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally { if (alive.current) setPhase(null); }
  }

  async function send() {
    if (busy || !info || !caps) return;
    const state = historyRef.current.present;
    setError('');
    // Nothing changed: the same path as sending without the editor.
    if (isUnedited(state, initial.format) && state.dynamicRange !== 'sdr') {
      setPhase('sending');
      try {
        try { await onReady(file); }
        catch (failure) {
          // The unchanged photo cannot keep HDR here (old system, HDR base): ask, then send it with normal brightness.
          if (!isHdrConsentError(failure) || !alive.current) throw failure;
          if (!await ask('Отправить без HDR?', 'HDR этого фото на этом устройстве не сохраняется. Фото можно отправить с обычной яркостью.', 'Отправить без HDR')) return;
          allowSdr(file.uri);
          await onReady(file);
        }
        if (alive.current) onCancel();
      }
      catch (failure) { if (alive.current) setError(errorText(failure)); }
      finally { if (alive.current) setPhase(null); }
      return;
    }
    let options = renderOptions(state, info, hdrSource && losesHdr(state));
    const size = photoSizePlan(info, options, caps);
    if (size.downsampled && !options.allowDownsample) {
      if (!await ask('Фото будет уменьшено', `Фото будет уменьшено до ${size.width} × ${size.height}, чтобы обработка поместилась в память устройства.`, 'Отправить')) return;
      options = { ...options, allowDownsample: true };
    }
    setPhase('sending');
    let result: PreparedPhoto | null = null;
    try {
      try { result = await renderPhoto(file, options); }
      catch (failure) {
        if (!isHdrConsentError(failure) || !alive.current) throw failure;
        if (!await ask('Отправить без HDR?', 'HDR на этом устройстве не сохраняется при такой обработке. Фото можно отправить с обычной яркостью.', 'Отправить без HDR')) return;
        result = await renderPhoto(file, { ...options, dynamicRange: 'sdr' });
      }
      await onReady(result.file);
      if (alive.current) onCancel();
    } catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally {
      await result?.dispose().catch(() => {});
      if (alive.current) setPhase(null);
    }
  }

  const cancel = () => { if (phase !== 'sending') onCancel(); };
  const displayUri = effect.preview?.uri ?? file.uri;
  const edited = !sameEdit(present, initial);
  const sizeText = plan && info ? `Результат: ${plan.width} × ${plan.height} · ${present.format === 'jpeg' ? 'JPEG' : 'PNG'}${plan.downsampled ? ' · фото будет уменьшено' : ''}. EXIF, GPS и личные метаданные удаляются.${info.dynamicRange === 'sdr' && info.dynamicRangeReason ? ` ${info.dynamicRangeReason}` : ''}` : '';
  const badge = hdrSource ? (sdrNow ? 'SDR' : 'HDR') : null;
  const explainBadge = () => Alert.alert(badge === 'HDR' ? 'HDR сохранится' : 'Без HDR',
    badge === 'HDR' ? 'Фото отправится с HDR: карта яркости повторит обрезку, поворот и рисунок.'
      : losesHdr(present) ? 'Выбранный режим (без фона, документ или PNG) сохраняет фото без HDR, с обычной яркостью.' : 'Фото отправится с обычной яркостью, без HDR.');

  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={cancel}>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000000', paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 52 }}>
        <IconButton name="close" color="#FFFFFF" label="Отменить редактирование фото" onPress={cancel} disabled={phase === 'sending'} />
        <IconButton name="arrow-undo-outline" color="#FFFFFF" label="Отменить действие" onPress={() => dispatch({ type: 'undo' })} disabled={busy || !canUndo(history)} />
        <IconButton name="arrow-redo-outline" color="#FFFFFF" label="Повторить действие" onPress={() => dispatch({ type: 'redo' })} disabled={busy || !canRedo(history)} />
        <View style={{ flex: 1 }} />
        {badge ? <Pressable onPress={explainBadge} accessibilityRole="button" accessibilityLabel={badge === 'HDR' ? 'HDR сохранится. Подробнее' : 'Фото без HDR. Подробнее'}
          style={{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: badge === 'HDR' ? '#FFD60A' : '#9AA3B2' }}>
          <Text style={{ color: badge === 'HDR' ? '#FFD60A' : '#9AA3B2', fontSize: 12, fontWeight: '800' }}>{badge}</Text>
        </Pressable> : null}
        <Pressable onPress={() => { setAspect(null); dispatch({ type: 'reset', initial }); }} disabled={busy || !edited} accessibilityRole="button" accessibilityLabel="Сбросить все изменения" accessibilityState={{ disabled: busy || !edited }}
          style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: busy || !edited ? .4 : 1 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 15 }}>Сбросить</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        {info ? <EditorCanvas sourceUri={file.uri} displayUri={displayUri} source={info} state={present} tool={TOOL[tab]} penColor={penColor} penWidth={penWidth} brushRadius={brushRadius}
          aspect={aspect} transparent={present.background === 'transparent'} hdr={hdrSource && !sdrNow} showMask={tab === 'remove'} disabled={busy}
          onPreview={next => dispatch({ type: 'preview', next })} onCommit={commit} onLimit={setError} />
          : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
            {phase === 'loading' ? <ActivityIndicator color="#FFFFFF" /> : <Icon name="image-outline" size={44} color="#9AA3B2" />}
            {error ? <>
              <Text style={{ color: '#FF8A80', textAlign: 'center' }}>{error}</Text>
              <Pressable onPress={() => setReload(value => value + 1)} accessibilityRole="button" style={{ padding: 10 }}><Text style={{ color: '#4DA3FF', fontSize: 15 }}>Попробовать открыть снова</Text></Pressable>
            </> : null}
          </View>}
        {effect.busy || phase === 'model' ? <View pointerEvents="none" accessibilityLiveRegion="polite" style={{ position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <ActivityIndicator color="#FFFFFF" size="small" /><Text style={{ color: '#FFFFFF', fontSize: 13 }}>{phase === 'model' ? 'Готовим удаление фона…' : 'Обрабатываем…'}</Text>
        </View> : null}
      </View>

      {info && (error || effect.error) ? <Text accessibilityLiveRegion="polite" style={{ color: '#FF8A80', fontSize: 12.5, textAlign: 'center', paddingHorizontal: 16, paddingTop: 6 }}>{error || effect.error}</Text> : null}
      {info && caps ? <View style={{ paddingTop: 10, gap: 10 }}>
        <ToolPanel tab={tab} state={present} disabled={busy} hdr={hdrSource} aspect={aspect} penColor={penColor} penWidth={penWidth} brushRadius={brushRadius}
          backgroundRemoval={caps.backgroundRemoval} backgroundReady={caps.backgroundReady} backgroundReason={caps.backgroundReason} preparingBackground={phase === 'model'}
          cropSourceTooLarge={cropSourceTooLarge} sizeText={sizeText}
          onAspect={pickAspect} onRotate={() => commit(rotated(present))} onFlip={() => commit(flipped(present))}
          onPenColor={setPenColor} onPenWidth={setPenWidth} onBrush={setBrushRadius} onChange={commit} onPrepareBackground={() => void prepareBackground()} />
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 12 }}>
          <View style={{ flex: 1 }}><TabBar tab={tab} disabled={phase === 'sending'} onTab={setTab} /></View>
          <Pressable onPress={() => void send()} disabled={busy || cropSourceTooLarge} accessibilityRole="button" accessibilityLabel={phase === 'sending' ? 'Готовим фото' : 'Отправить фото'} accessibilityState={{ disabled: busy || cropSourceTooLarge, busy: phase === 'sending' }}
            style={({ pressed }) => ({ width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A84FF', opacity: busy && phase !== 'sending' || cropSourceTooLarge ? .45 : pressed ? .8 : 1 })}>
            {phase === 'sending' ? <ActivityIndicator color="#FFFFFF" /> : <Icon name="checkmark" size={28} color="#FFFFFF" />}
          </Pressable>
        </View>
        {phase === 'sending' ? <Text style={{ color: '#9AA3B2', fontSize: 12, textAlign: 'center' }}>Готовим фото…</Text> : null}
      </View> : null}
    </GestureHandlerRootView>
  </Modal>;
}
