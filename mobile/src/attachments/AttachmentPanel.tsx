import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Button, Icon, IconButton, Notice, type IconName } from '../components';
import { GlassStage, GlassSurface } from '../glass';
import { formatSize, useTheme } from '../theme';
import type { LocalFile } from '../types';
import { useMusic } from '../music/MusicProvider';
import { mediaPreviewKind } from '../media/formats';
import { PhotoEditor } from '../photo/PhotoEditor';
import { GalleryPane } from './GalleryPane';
import { resolveSelection } from './gallery';
import { addSelections, toggleSelection, type AttachmentSelection } from './selection';
import { addSelectionQueue } from './uploadQueue';

type Tab = 'gallery' | 'audio' | 'files';
type Phase = 'picking' | 'opening' | 'adding' | null;
const kindIcon = (kind: AttachmentSelection['kind']): IconName => ({ photo: 'image-outline', video: 'videocam-outline', audio: 'musical-note-outline', file: 'document-outline' } as const)[kind];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось добавить вложение.';
const fromFile = (file: LocalFile): AttachmentSelection => ({ id: `file:${file.uri}`, file, kind: mediaPreviewKind(file) });

/** Editor output is uploaded while its lease is alive; only unprocessed originals
 * stay selected. A partial batch failure keeps the remaining queue for retry. */
export function AttachmentPanel({ visible, busy, canAdd, remainingSlots, onClose, onAdd, onPoll }: {
  visible: boolean; busy: boolean; canAdd: boolean; remainingSlots: number; onClose: () => void; onAdd: (item: AttachmentSelection) => Promise<void>; onPoll?: () => void;
}) {
  const t = useTheme(), window = useWindowDimensions(), insets = useSafeAreaInsets(), music = useMusic();
  const [tab, setTab] = useState<Tab>('gallery'), [selected, setSelected] = useState<AttachmentSelection[]>([]);
  const [editing, setEditing] = useState<AttachmentSelection | null>(null), [phase, setPhase] = useState<Phase>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const selectedRef = useRef(selected), visibleRef = useRef(visible), alive = useRef(true), operation = useRef(0), working = useRef(false);
  visibleRef.current = visible;
  const locked = busy || phase !== null;
  const help = { color: t.muted, fontSize: 12, lineHeight: 18 };
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current += 1; }; }, []);
  const valid = (ticket: number) => alive.current && visibleRef.current && ticket === operation.current;
  function replaceSelection(next: AttachmentSelection[]) { selectedRef.current = next; setSelected(next); }
  function choose(item: AttachmentSelection) {
    if (working.current || busy) return;
    try { replaceSelection(toggleSelection(selectedRef.current, item, remainingSlots)); setError(''); setNotice(''); }
    catch (failure) { setError(errorText(failure)); }
  }
  function close() {
    if (phase === 'adding' || busy) return;
    operation.current += 1; working.current = false;
    replaceSelection([]); setEditing(null); setError(''); setNotice(''); setPhase(null); onClose();
  }
  function start(nextPhase: Exclude<Phase, null>) {
    working.current = true; setPhase(nextPhase); setError(''); setNotice('');
    return ++operation.current;
  }
  function finish(ticket: number) { if (alive.current && ticket === operation.current) { working.current = false; setPhase(null); } }

  async function edit(item: AttachmentSelection) {
    if (item.kind !== 'photo' || working.current || busy) return;
    const ticket = start('opening');
    try { const resolved = await resolveSelection(item); if (valid(ticket)) setEditing(resolved); }
    catch (failure) { if (valid(ticket)) setError(errorText(failure)); }
    finally { finish(ticket); }
  }

  async function addEdited(file: LocalFile) {
    if (!editing || working.current || busy) throw new Error('Дождись завершения текущего добавления.');
    if (!canAdd) throw new Error('Отправка со сквозным шифрованием доступна в приложении Android или iPhone.');
    addSelections(selectedRef.current, [editing], remainingSlots);
    const ticket = start('adding'), editedId = editing.id;
    try {
      await onAdd({ ...editing, assetId: undefined, file });
      if (!valid(ticket)) return;
      const remaining = selectedRef.current.filter(item => item.id !== editedId);
      replaceSelection(remaining); setNotice('Фото добавлено в сообщение.');
      if (!remaining.length) onClose();
    } finally { finish(ticket); }
  }

  async function addSelected() {
    if (working.current || busy || !canAdd || !selectedRef.current.length) return;
    try { addSelections([], selectedRef.current, remainingSlots); }
    catch (failure) { setError(errorText(failure)); return; }
    const ticket = start('adding'), batch = [...selectedRef.current];
    try {
      await addSelectionQueue(batch, { isCurrent: () => valid(ticket), resolve: resolveSelection, add: onAdd, dispose: item => item.dispose(), added: (item, completed) => {
        replaceSelection(selectedRef.current.filter(value => value.id !== item.id));
        setNotice(`Добавлено в сообщение: ${completed} из ${batch.length}`);
      } });
      if (valid(ticket)) { setNotice(''); onClose(); }
    } catch (failure) { if (valid(ticket)) setError(errorText(failure)); }
    finally { finish(ticket); }
  }

  async function pickDocuments(audio: boolean) {
    if (working.current || busy) return;
    const ticket = start('picking');
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: audio ? 'audio/*' : '*/*', multiple: true, copyToCacheDirectory: true });
      if (!result.canceled && valid(ticket)) {
        const files = result.assets.map(asset => fromFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType || 'application/octet-stream', size: asset.size, file: asset.file }));
        replaceSelection(addSelections(selectedRef.current, files, remainingSlots));
      }
    } catch (failure) { if (valid(ticket)) setError(errorText(failure)); }
    finally { finish(ticket); }
  }

  async function camera() {
    if (working.current || busy || Platform.OS === 'web') return;
    const ticket = start('picking');
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) throw new Error('Разреши доступ к камере в настройках, чтобы снимать прямо из чата.');
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 1, exif: false, allowsEditing: false, videoMaxDuration: 600 });
      if (!result.canceled && valid(ticket)) {
        const files = result.assets.map(asset => fromFile({ uri: asset.uri, name: asset.fileName || (asset.type === 'video' ? 'video.mp4' : 'photo.jpg'), mimeType: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'), size: asset.fileSize }));
        replaceSelection(addSelections(selectedRef.current, files, remainingSlots));
      }
    } catch (failure) { if (valid(ticket)) setError(errorText(failure)); }
    finally { finish(ticket); }
  }

  async function systemGallery() {
    if (Platform.OS === 'web') { await pickDocuments(false); return; }
    if (working.current || busy) return;
    const ticket = start('picking');
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: Math.max(1, remainingSlots), quality: 1, exif: false,
        allowsEditing: false, videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      });
      if (!result.canceled && valid(ticket)) {
        const files = result.assets.map(asset => fromFile({ uri: asset.uri, name: asset.fileName || (asset.type === 'video' ? 'video.mp4' : 'photo.jpg'), mimeType: asset.mimeType || (asset.type === 'video' ? 'video/*' : 'image/*'), size: asset.fileSize, file: asset.file }));
        replaceSelection(addSelections(selectedRef.current, files, remainingSlots));
      }
    } catch (failure) { if (valid(ticket)) setError(errorText(failure)); }
    finally { finish(ticket); }
  }

  const localTracks = music.saved.filter(track => track.source === 'local' && track.localUri?.startsWith('file://'));
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
    <GlassStage><View style={{ flex: 1, justifyContent: 'flex-end', paddingHorizontal: 10, paddingBottom: Math.max(10, insets.bottom), backgroundColor: t.black ? 'rgba(0,0,0,.45)' : t.dark ? 'rgba(0,5,19,.38)' : 'rgba(43,63,103,.14)' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть выбор вложений" onPress={close} style={StyleSheet.absoluteFill} />
      <GlassSurface material="regular" radius={30} style={{ alignSelf: 'center', width: '100%', maxWidth: 600, height: Math.min(650, Math.max(390, window.height * .7)) }} contentStyle={{ flex: 1, padding: 12, gap: 9 }}>
        <View style={{ alignSelf: 'center', width: 35, height: 4, borderRadius: 2, backgroundColor: t.subtle, opacity: .45 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconButton name="close" label="Закрыть выбор вложений" onPress={close} disabled={phase === 'adding' || busy} style={{ height: 44, width: 44, borderRadius: 22, backgroundColor: t.surface2 }} />
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700', letterSpacing: -.3 }}>{tab === 'gallery' ? (selected.length ? `Выбрано: ${selected.length}` : 'Недавние') : tab === 'audio' ? 'Аудио' : 'Файлы'}</Text>
          <View style={{ width: 44 }} />
        </View>
        <View style={{ flex: 1, minHeight: 0 }}>
          {tab === 'gallery' ? <GalleryPane onCamera={() => void camera()} active={visible && !editing} selectedIds={selected.map(item => item.id)} disabled={locked} onToggle={choose} onEdit={item => void edit(item)} onFallback={() => void systemGallery()} /> : tab === 'audio' ? <ScrollView contentContainerStyle={{ padding: 7, gap: 12 }}>
            <Button secondary icon="musical-notes-outline" label="Выбрать аудио на устройстве" disabled={locked} onPress={() => void pickDocuments(true)} />
            <Text style={help}>Прикрепи локальный аудиофайл или трек, который ты импортировал в музыку.</Text>
            {localTracks.length ? <Text style={{ color: t.text, fontSize: 13, fontWeight: '700', paddingTop: 6 }}>Из моей музыки</Text> : <View style={{ paddingVertical: 16, alignItems: 'center', gap: 10 }}><Icon name="headset-outline" color={t.subtle} size={38} /><Text style={help}>Импортированных треков пока нет</Text></View>}
            {localTracks.map(track => {
              const item: AttachmentSelection = { id: `music:${track.id}`, kind: 'audio', file: { uri: track.localUri!, name: track.fileName || track.title, mimeType: track.mimeType || 'audio/*', size: track.fileSize } };
              const number = selected.findIndex(value => value.id === item.id) + 1;
              return <Pressable key={item.id} disabled={locked} accessibilityRole="checkbox" accessibilityState={{ checked: !!number, disabled: locked }} onPress={() => choose(item)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 18, backgroundColor: number ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: number ? t.accent : t.border }}><Icon name="musical-note" color={t.accent} size={23} /><View style={{ flex: 1, gap: 4 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{track.title}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 11 }}>{track.artist}{track.fileSize ? ` · ${formatSize(track.fileSize)}` : ''}</Text></View><Icon name={number ? 'checkmark-circle' : 'ellipse-outline'} color={number ? t.accent : t.subtle} size={24} /></Pressable>;
            })}
          </ScrollView> : <ScrollView contentContainerStyle={{ padding: 18, gap: 15 }}><Icon name="folder-open-outline" color={t.accent} size={38} /><Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>Файлы с устройства</Text><Text style={help}>Можно выбрать несколько документов, фото, видео или аудиофайлов. Для вложения действует лимит 20 МБ.</Text><Button secondary icon="document-outline" label="Открыть файлы" disabled={locked} onPress={() => void pickDocuments(false)} /><Text style={help}>Фото и видео проходят очистку личных метаданных даже без редактора. Если устройство не поддерживает формат или сохранение HDR, приложение объяснит причину и остановит отправку.</Text></ScrollView>}
        </View>
        {selected.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingVertical: 3 }}>
          {selected.map((item, index) => <View key={item.id} style={{ maxWidth: 200, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 14, backgroundColor: t.accentSoft, paddingLeft: 9, paddingVertical: 3, borderWidth: 1, borderColor: t.border }}><Text style={{ color: t.accent, fontSize: 10, fontWeight: '700' }}>{index + 1}</Text><Icon name={kindIcon(item.kind)} color={t.accent} size={15} /><Pressable disabled={locked || item.kind !== 'photo'} accessibilityRole={item.kind === 'photo' ? 'button' : undefined} accessibilityLabel={`Редактировать ${item.file.name}`} onPress={() => void edit(item)} style={{ flexShrink: 1, paddingVertical: 7 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 11 }}>{item.file.name}</Text></Pressable><IconButton name="close" size={15} label={`Убрать ${item.file.name}`} disabled={locked} onPress={() => choose(item)} style={{ height: 30, width: 30 }} /></View>)}
        </ScrollView> : null}
        {error ? <Notice text={error} error /> : null}
        {phase || notice ? <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 5 }}>{phase ? <ActivityIndicator color={t.accent} size="small" /> : <Icon name="checkmark-circle" color={t.accent} size={16} />}<Text style={[help, { flex: 1, fontSize: 11 }]}>{notice || (phase === 'opening' ? 'Открываем оригинал; файл из iCloud может загружаться…' : phase === 'picking' ? 'Выбери файлы в системном окне…' : 'Обрабатываем, шифруем и добавляем…')}</Text></View> : null}
        {!canAdd ? <Text style={{ color: t.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' }}>Отправка со сквозным шифрованием доступна в приложении Android или iPhone.</Text> : null}
        {selected.length || phase === 'adding' ? <Button icon="arrow-up" label={`Добавить · ${selected.length}`} loading={phase === 'adding'} disabled={locked || !canAdd || !selected.length} onPress={() => void addSelected()} /> : null}
        <View accessibilityRole="tablist" style={{ flexDirection: 'row', alignSelf: 'center', padding: 5, gap: 2, borderRadius: 30, backgroundColor: t.dark ? 'rgba(30,34,48,0.96)' : 'rgba(255,255,255,0.96)', borderWidth: 1, borderColor: t.border }}>
          {([{ id: 'gallery', label: 'Галерея', icon: 'images' }, { id: 'files', label: 'Файл', icon: 'document' }, ...(onPoll ? [{ id: 'poll', label: 'Опрос', icon: 'stats-chart' }] : []), { id: 'audio', label: 'Аудио', icon: 'musical-notes' }] as { id: Tab | 'poll'; label: string; icon: IconName }[]).map(item => { const active = tab === item.id; return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: active, disabled: locked }} disabled={locked} onPress={() => { if (item.id === 'poll') { replaceSelection([]); onPoll?.(); } else setTab(item.id); }} style={{ minWidth: 72, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 24, alignItems: 'center', gap: 3, backgroundColor: active ? t.accentSoft : 'transparent' }}><Icon name={item.icon} size={22} color={active ? t.accent : t.text} /><Text style={{ color: active ? t.accent : t.text, fontSize: 11, fontWeight: '600' }}>{item.label}</Text></Pressable>; })}
        </View>
        {selected.length > 1 ? <Text style={{ color: t.muted, fontSize: 10, textAlign: 'center' }}>Несколько фото и видео отправятся одним альбомом.</Text> : null}
        {Platform.OS === 'ios' && selected.some(item => item.kind === 'video' && item.assetId) ? <Text style={{ color: t.muted, fontSize: 10, lineHeight: 15, textAlign: 'center' }}>Видео из галереи — оригинал. Изменения монтажа и скорости из приложения «Фото» не переносятся; оригинал из iCloud загрузится после подтверждения.</Text> : null}
      </GlassSurface>
      {editing ? <PhotoEditor key={editing.id} file={editing.file} onCancel={() => setEditing(null)} onReady={addEdited} /> : null}
    </View></GlassStage>
  </Modal>;
}
