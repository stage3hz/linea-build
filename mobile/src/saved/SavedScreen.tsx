import React, { useEffect, useMemo, useRef, useState } from 'react';
import { linkify } from '../linkify';
import { RightClick } from '../RightClick';
import { ContextMenu, MenuItem } from '../ContextMenu';
import { ComposerInput } from '../ComposerInput';
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { Text, TextInput } from '../typography';
import { KeyboardSafeView } from '../keyboard';
import { AttachmentCard, Empty, Icon, IconButton, Notice, RecordHint, Sheet, SheetAction } from '../components';
import { GlassSurface } from '../glass';
import { formatDay, formatTime, useTheme } from '../theme';
import type { Api } from '../api';
import type { Attachment, User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { signalAvailable } from '../e2ee/signal';
import { shareEncryptedAttachment } from '../e2ee/attachments';
import { AttachmentPanel } from '../attachments/AttachmentPanel';
import { AttachmentViewer } from '../media/AttachmentViewer';
import { openDocument } from '../media/documentPreview';
import { mediaPreviewKind } from '../media/formats';
import { textMetrics, useChatPreferences } from '../chatPreferences';
import { VoiceBubble, VoicePlaybackProvider, VoiceRecordingBar, useVoiceRecorder } from '../voice/VoiceMessage';
import { VOICE_MIME, VOICE_MIN_MS, attachmentLabel, isVideoNote, isVoice, videoNoteFileName, voiceFileName } from '../voice/voice';
import { RecordButton, type RecordKind } from '../voice/RecordButton';
import { VideoNoteBubble, VideoNoteRecorder, type VideoHold, type VideoNoteTake } from '../videonote/VideoNote';
import { errorFeedback, lightFeedback } from '../haptics';
import { searchSaved, type SavedItem } from './saved.ts';

export function SavedScreen({ api, user, store, onBack, wide = false }: { api: Api; user: User; store: MessengerStore; onBack: () => void; wide?: boolean }) {
  const t = useTheme(); const saved = store.saved;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<SavedItem | null>(null);
  const [actions, setActions] = useState<SavedItem | null>(null); const [at, setAt] = useState<{ x?: number; y: number }>({ y: 300 });
  const [forwarding, setForwarding] = useState<SavedItem | null>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchOpen, setSearchOpen] = useState(false); const [query, setQuery] = useState('');
  // PC: Ctrl+F opens the search, Esc closes it — as in chats.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen(true); } else if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const busyRef = useRef(false); const listRef = useRef<FlatList<SavedItem>>(null);
  const metrics = textMetrics(useChatPreferences().textSize);
  const rows = useMemo(() => [...(searchOpen ? searchSaved(saved.items, query) : saved.items)].reverse(), [saved.items, searchOpen, query]);
  const flash = (value: string) => { setNotice(value); setTimeout(() => setNotice(current => current === value ? '' : current), 2200); };
  const fail = (e: unknown, fallback: string) => setError(e instanceof Error ? e.message : fallback);

  const submit = () => {
    const value = text.trim(); if (!value) return;
    if (editing) { saved.edit(editing.id, value).then(() => { setEditing(null); setText(''); }).catch(e => fail(e, 'Не удалось изменить заметку.')); return; }
    saved.save(value, null).then(() => { setText(''); listRef.current?.scrollToOffset({ offset: 0, animated: true }); }).catch(e => fail(e, 'Не удалось сохранить заметку.'));
  };
  const uploadAndSave = async (file: { uri: string; name: string; mimeType: string; size?: number }, extra?: Partial<Attachment>) => {
    if (!signalAvailable) throw new Error('Файлы в Избранном доступны в приложении Android или iPhone.');
    if (busyRef.current) throw new Error('Дождись завершения текущей загрузки.');
    busyRef.current = true; setBusy(true); setError('');
    try {
      const uploaded = await store.uploadEncrypted(file);
      await saved.save(text, { ...uploaded, ...extra });
      setText(''); listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) { fail(e, 'Не удалось зашифровать и сохранить файл.'); throw e; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const finishVoice = async (keep: boolean) => {
    const take = await voice.finish(keep).catch(e => { fail(e, 'Не удалось остановить запись.'); return null; });
    if (!take) return;
    try {
      if (take.durationMs < VOICE_MIN_MS) { errorFeedback(); flash('Слишком короткая запись.'); return; }
      const name = voiceFileName();
      await uploadAndSave({ uri: take.uri, name, mimeType: VOICE_MIME }, { name, mimeType: VOICE_MIME, media: { durationMs: Math.round(take.durationMs), ...(take.waveform ? { waveform: take.waveform } : {}) } }).catch(() => {});
    } finally { await FileSystem.deleteAsync(take.uri, { idempotent: true }).catch(() => {}); }
  };
  const voice = useVoiceRecorder(() => void finishVoice(true));
  // The same record button as in chats (Telegram): hold to record, slide left to cancel, up for hands
  // free; a tap switches voice ↔ round video. Refs: gesture callbacks may outlive their render.
  const [recordMode, setRecordMode] = useState<RecordKind>('voice'); const recordModeRef = useRef(recordMode); recordModeRef.current = recordMode;
  const [recHold, setRecHold] = useState<{ kind: RecordKind; locked: boolean } | null>(null); const recHoldRef = useRef(recHold); recHoldRef.current = recHold;
  const [cancelProgress, setCancelProgress] = useState(0);
  const [videoHold, setVideoHold] = useState<VideoHold | null>(null); const [circleOpen, setCircleOpen] = useState(false);
  const [recordHint, setRecordHint] = useState(''); const recordHintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toggleRecordMode = () => { lightFeedback(); voice.unprepare(); const next = recordModeRef.current === 'voice' ? 'video' : 'voice'; recordModeRef.current = next; setRecordMode(next); setRecordHint(next === 'video' ? 'Видео — удерживайте. Звук — нажмите.' : 'Звук — удерживайте. Видео — нажмите.'); if (recordHintTimer.current) clearTimeout(recordHintTimer.current); recordHintTimer.current = setTimeout(() => setRecordHint(''), 2200); };
  const holdStart = () => {
    Keyboard.dismiss(); setError('');
    if (recordModeRef.current === 'voice') { setRecHold({ kind: 'voice', locked: false }); voice.start().catch(e => { setRecHold(null); fail(e, 'Не удалось начать запись.'); }); }
    else { setVideoHold({ stop: 0, cancel: 0, locked: false }); setCircleOpen(true); setRecHold({ kind: 'video', locked: false }); }
  };
  const holdEnd = (result: 'send' | 'cancel') => {
    const kind = recHoldRef.current?.kind ?? recordModeRef.current; setRecHold(null); setCancelProgress(0);
    if (kind === 'voice') void finishVoice(result === 'send');
    else setVideoHold(v => v ? { ...v, stop: v.stop + (result === 'send' ? 1 : 0), cancel: v.cancel + (result === 'cancel' ? 1 : 0) } : v);
  };
  const holdLock = () => { setCancelProgress(0); setRecHold(h => h ? { ...h, locked: true } : h); setVideoHold(v => v ? { ...v, locked: true } : v); };
  const saveVideoNote = async (take: VideoNoteTake) => {
    setCircleOpen(false); setVideoHold(null); setRecHold(null);
    try { const name = videoNoteFileName(); await uploadAndSave({ uri: take.uri, name: 'video.mp4', mimeType: 'video/mp4' }, { name, mimeType: 'video/mp4', media: { durationMs: Math.round(take.durationMs) } }).catch(() => {}); }
    finally { await FileSystem.deleteAsync(take.uri, { idempotent: true }).catch(() => {}); }
  };
  const open = (file: Attachment) => {
    if (mediaPreviewKind(file) !== 'file') setPreview(file);
    else openDocument(api, file).then(shown => { if (!shown) setPreview(file); }).catch(e => fail(e, 'Не удалось открыть файл.'));
  };
  const copy = async (value: string) => { await Clipboard.setStringAsync(value); setActions(null); flash('Скопировано'); };

  return <VoicePlaybackProvider api={api}><KeyboardSafeView style={{ flex: 1, backgroundColor: 'transparent' }}>
    <GlassSurface material="regular" radius={27} style={{ marginHorizontal: 12, marginTop: 12, marginBottom: 8 }} contentStyle={{ minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: wide ? 17 : 8, paddingVertical: 10 }}>
      {!wide ? <IconButton name="chevron-back" label="Назад к чатам" onPress={onBack} style={{ width: 38, height: 43 }} /> : null}
      <View style={{ width: 43, height: 43, borderRadius: 16, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name="bookmark" color={t.onAccent} size={21} /></View>
      <View style={{ flex: 1, gap: 4 }}><Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Избранное</Text><Text style={{ color: t.muted, fontSize: 11 }}>{saved.items.length ? `${saved.items.length} · только на этом устройстве` : 'Хранится только на этом устройстве'}</Text></View>
      <IconButton name={searchOpen ? 'close' : 'search-outline'} label={searchOpen ? 'Закрыть поиск' : 'Поиск в Избранном'} onPress={() => { setSearchOpen(!searchOpen); setQuery(''); }} color={searchOpen ? t.accent : t.muted} style={{ width: 39, height: 43 }} />
    </GlassSurface>
    {searchOpen ? <GlassSurface material="regular" radius={22} shadow={false} style={{ marginHorizontal: 12, marginBottom: 6 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, minHeight: 46 }}>
      <Icon name="search-outline" size={18} color={t.muted} />
      <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Поиск в Избранном" placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} style={{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 10 }} />
    </GlassSurface> : null}
    {notice ? <View style={{ alignSelf: 'center', marginVertical: 4, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: t.accentSoft, borderRadius: 16, borderWidth: 1, borderColor: t.border }}><Text style={{ color: t.accent, fontSize: 12 }}>{notice}</Text></View> : null}
    {error || saved.error ? <View style={{ paddingHorizontal: 13, paddingVertical: 6 }}><Notice text={error || saved.error} error /></View> : null}
    {!saved.loaded ? <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={t.accent} /></View> : rows.length === 0 ? <View style={{ flex: 1, justifyContent: 'center' }}><Empty icon={searchOpen ? 'search-outline' : 'bookmark-outline'} title={searchOpen ? 'Ничего не найдено' : 'Здесь пока пусто'} description={searchOpen ? 'Попробуй другое слово.' : 'Пиши заметки, сохраняй файлы и голосовые. Любое сообщение из чата можно отправить сюда через долгое нажатие → «В Избранное».'} /></View> :
      <FlatList ref={listRef} inverted data={rows} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} contentContainerStyle={{ paddingHorizontal: wide ? 28 : 15, paddingVertical: 14 }}
        renderItem={({ item, index }) => {
          const older = rows[index + 1]; const showDay = !older || new Date(older.savedAt).toDateString() !== new Date(item.savedAt).toDateString();
          return <View>
            {showDay ? <View style={{ alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, marginTop: 15, marginBottom: 14, backgroundColor: t.dark ? 'rgba(30,36,53,0.68)' : 'rgba(255,255,255,0.52)' }}><Text style={{ color: t.muted, fontSize: 10, fontWeight: '600' }}>{formatDay(item.savedAt)}</Text></View> : null}
            <View style={{ alignItems: 'flex-end', marginBottom: 8 }}>
              <RightClick onMenu={(x, y) => { setAt({ x, y }); setActions(item); }} style={{ maxWidth: wide ? '76%' : '85%', alignItems: 'flex-end' }}><Pressable onLongPress={e => { setAt({ y: e.nativeEvent.pageY }); setActions(item); }} delayLongPress={400} accessibilityLabel={item.text || item.attachment?.name || 'Запись'} style={{ maxWidth: '100%', minWidth: 74, backgroundColor: t.bubble, borderRadius: 23, borderBottomRightRadius: 8, paddingHorizontal: 12, paddingTop: item.attachment ? 7 : 11, paddingBottom: 7, borderWidth: 1, borderColor: t.dark ? 'rgba(157,182,255,0.25)' : 'rgba(255,255,255,0.83)' }}>
                {item.origin ? <Text style={{ color: t.accent, fontSize: 11, fontWeight: '600', marginBottom: 4 }}>{item.origin.author === user.displayName ? 'Твоё сообщение' : `От ${item.origin.author}`} · {formatDay(item.origin.sentAt)}</Text> : null}
                {item.attachment ? <View style={{ marginBottom: item.text ? 7 : 1 }}>{isVoice(item.attachment) ? <VoiceBubble attachment={item.attachment} mine /> : isVideoNote(item.attachment) ? <VideoNoteBubble api={api} attachment={item.attachment} /> : <AttachmentCard api={api} attachment={item.attachment} onPress={() => open(item.attachment!)} />}</View> : null}
                {item.text ? <Text selectable={false} style={{ color: t.text, fontSize: metrics.fontSize, lineHeight: metrics.lineHeight }}>{linkify(item.text, t.accent)}</Text> : null}
                <Text style={{ color: t.muted, fontSize: 9, alignSelf: 'flex-end', marginTop: 4 }}>{item.editedAt ? 'изм. ' : ''}{formatTime(item.savedAt)}</Text>
              </Pressable></RightClick>
            </View>
          </View>;
        }} />}
    <GlassSurface material="regular" radius={28} style={{ marginHorizontal: 12, marginTop: 5, marginBottom: 10 }} contentStyle={{ padding: 8 }}>
      {editing ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingBottom: 6 }}><Icon name="create-outline" size={18} color={t.accent} /><Text style={{ flex: 1, color: t.accent, fontSize: 12, fontWeight: '700' }}>Редактирование заметки</Text><IconButton name="close" label="Отменить редактирование" size={18} color={t.muted} onPress={() => { setEditing(null); setText(''); }} style={{ width: 36, height: 36 }} /></View> : null}
      {busy ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 10, paddingTop: 4 }}><ActivityIndicator size="small" color={t.accent} /><Text style={{ fontSize: 12, color: t.muted }}>Шифруем и сохраняем…</Text></View> : null}
      {voice.active && !(recHold?.kind === 'voice' && !recHold.locked) ? <VoiceRecordingBar durationMs={voice.durationMs} levels={voice.levels} paused={voice.paused} onPause={voice.togglePause} onCancel={() => { setRecHold(null); void finishVoice(false); }} onSend={() => { setRecHold(null); void finishVoice(true); }} /> :

        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>
          <RecordHint text={recordHint} bottom={52} />
          {recHold?.kind === 'voice' && !recHold.locked ? <View key="strip" style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}><VoiceRecordingBar holding cancelProgress={cancelProgress} durationMs={voice.durationMs} levels={voice.levels} onCancel={() => {}} onSend={() => {}} /></View> : <>
          <IconButton name="add" label="Сохранить фото, видео или файл" onPress={() => { Keyboard.dismiss(); setAttachMenu(true); }} color={t.accent} disabled={busy || !!editing} style={{ width: 44, height: 44, borderRadius: 21 }} />
          <View style={{ flex: 1, minHeight: 44, maxHeight: 140, justifyContent: 'center' }}><ComposerInput focusKey={editing ? `edit:${editing.id}` : null} accessibilityLabel="Заметка" placeholder="Заметка…" value={text} onChangeText={setText} onKeyPress={e => { if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !(e.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) { e.preventDefault(); submit(); } }} placeholderTextColor={t.muted} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} multiline maxLength={8000} style={{ fontSize: 15, lineHeight: 21, color: t.text, paddingHorizontal: 6, paddingTop: Platform.OS === 'ios' ? 11 : 10, paddingBottom: 11, maxHeight: 136 }} /></View>
          </>}
          {!text.trim() && !editing && signalAvailable ? <View key="rec" style={{ zIndex: 5, height: 44, justifyContent: 'center' }}><RecordButton mode={recordMode} disabled={busy} onTouchDown={() => { if (recordModeRef.current === 'voice') voice.prepare(); }} level={recHold?.kind === 'voice' ? voice.levels.at(-1) || 0 : 0} onToggleMode={toggleRecordMode} onHoldStart={holdStart} onHoldEnd={holdEnd} onLock={holdLock} onSlide={setCancelProgress} /></View> :
            <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Сохранить изменения' : 'Сохранить заметку'} disabled={!text.trim() || busy} onPress={submit} style={({ pressed }) => ({ height: 44, width: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: !text.trim() || busy ? .4 : pressed ? .75 : 1 })}><Icon name={editing ? 'checkmark' : 'arrow-up'} color={t.onAccent} size={23} /></Pressable>}
        </View>}
    </GlassSurface>
    <VideoNoteRecorder visible={circleOpen} hold={videoHold} onClose={() => { setCircleOpen(false); setVideoHold(null); setRecHold(null); }} onDone={take => void saveVideoNote(take)} />
    <AttachmentPanel visible={attachMenu} busy={busy} canAdd={signalAvailable} remainingSlots={1} onClose={() => setAttachMenu(false)} onAdd={item => uploadAndSave(item.file)} />
    {/* Same menu as in chats: at the cursor on PC (Telegram Desktop), over the message on phones. */}
    <ContextMenu visible={!!actions} x={at.x} y={at.y} mine preview={actions?.text || (actions?.attachment ? attachmentLabel(actions.attachment) : undefined)} onClose={() => setActions(null)}>
      {actions?.text ? <MenuItem icon="copy-outline" label="Скопировать текст" onPress={() => void copy(actions.text)} /> : null}
      {actions && !actions.origin && actions.text ? <MenuItem icon="create-outline" label="Изменить" onPress={() => { setEditing(actions); setText(actions.text); setActions(null); }} /> : null}
      {actions ? <MenuItem icon="arrow-redo-outline" label="Переслать в чат" onPress={() => { setForwarding(actions); setActions(null); }} /> : null}
      {actions?.attachment ? <MenuItem icon="download-outline" label="Сохранить файл" onPress={() => { const file = actions.attachment!; setActions(null); shareEncryptedAttachment(api, file).catch(e => fail(e, 'Не удалось открыть файл.')); }} /> : null}
      {actions ? <MenuItem separated icon="trash-outline" label="Удалить из Избранного" danger onPress={() => { const id = actions.id; setActions(null); saved.remove(id).catch(e => fail(e, 'Не удалось удалить.')); }} /> : null}
    </ContextMenu>
    <Sheet visible={!!forwarding} title="Переслать в чат" onClose={() => setForwarding(null)}>
      {store.chats.length ? store.chats.map(target => <SheetAction key={target.id} icon="chatbubble-outline" label={target.peer.displayName} description={`@${target.peer.username}`} onPress={() => {
        const item = forwarding!; setForwarding(null);
        store.forward(target.id, { text: item.text, attachment: item.attachment, senderId: user.id }, item.origin?.author || user.displayName).then(() => flash(`Переслано: ${target.peer.displayName}`)).catch(e => fail(e, 'Не удалось переслать.'));
      }} />) : <Text style={{ color: t.muted, fontSize: 13 }}>Пока нет чатов.</Text>}
    </Sheet>
    <AttachmentViewer api={api} attachment={preview} onClose={() => setPreview(null)} />
  </KeyboardSafeView></VoicePlaybackProvider>;
}
