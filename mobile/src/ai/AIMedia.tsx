import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, View } from 'react-native';
import { Text, TextInput } from '../typography';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { fromByteArray } from 'base64-js';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { Api } from '../api';
import { Button, Icon, Notice } from '../components';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { aiImage, aiSpeech, aiTranscribe, aiVideo } from './client';

export type MediaMode = 'image' | 'video' | 'speech' | 'transcribe';
const VOICES = [{ id: 'nova', label: 'Нова' }, { id: 'alloy', label: 'Альт' }, { id: 'echo', label: 'Эхо' }, { id: 'onyx', label: 'Оникс' }, { id: 'shimmer', label: 'Шиммер' }, { id: 'fable', label: 'Фейбл' }];
const MAX_TRANSCRIBE = 10 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'video/mp4': 'mp4' };

/** Writes AI output to the app cache; the screen deletes it when replaced or closed. */
async function writeCache(base64: string, mimeType: string): Promise<string> {
  const dir = FileSystem.cacheDirectory; if (!dir) throw new Error('Кэш недоступен на этом устройстве.');
  const uri = `${dir}linea-ai-${Crypto.randomUUID()}.${EXT[mimeType] || 'bin'}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

function useCachedFile() {
  const [file, setFile] = useState<{ uri: string; mimeType: string } | null>(null);
  const ref = useRef(file); ref.current = file;
  useEffect(() => () => { if (ref.current) void FileSystem.deleteAsync(ref.current.uri, { idempotent: true }).catch(() => {}); }, []);
  const replace = (next: { uri: string; mimeType: string } | null) => { if (ref.current) void FileSystem.deleteAsync(ref.current.uri, { idempotent: true }).catch(() => {}); setFile(next); };
  return [file, replace] as const;
}

async function share(uri: string, mimeType: string) {
  if (!await Sharing.isAvailableAsync()) throw new Error('На устройстве недоступно меню «Поделиться».');
  await Sharing.shareAsync(uri, { mimeType });
}

export function AIMediaPanel({ api, mode, consent }: { api: Api; mode: MediaMode; consent: boolean }) {
  const t = useTheme();
  const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [via, setVia] = useState('');
  const [voice, setVoice] = useState('nova'), [duration, setDuration] = useState(5), [transcript, setTranscript] = useState('');
  const [file, setFile] = useCachedFile();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { controller.current?.abort(); setPrompt(''); setError(''); setVia(''); setTranscript(''); setFile(null); setBusy(false); }, [mode]);
  useEffect(() => () => controller.current?.abort(), []);
  const help = { color: t.muted, fontSize: 12, lineHeight: 18 };

  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (!consent) { setError('Сначала разреши отправлять запросы внешней AI-службе (переключатель выше).'); return; }
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setVia('');
    try { await work(current.signal); }
    catch (e) { if (!current.signal.aborted) setError(e instanceof Error ? e.message : 'AI не справился с задачей. Попробуй ещё раз.'); }
    finally { if (controller.current === current) { controller.current = null; setBusy(false); } }
  };

  const generateImage = () => run(async signal => {
    const result = await aiImage(api, prompt.trim(), signal); if (signal.aborted) return;
    setFile({ uri: await writeCache(result.base64, result.mimeType), mimeType: result.mimeType }); setVia(result.routedVia || '');
  });
  const generateVideo = () => run(async signal => {
    const bytes = await aiVideo(api, prompt.trim(), duration, signal); if (signal.aborted) return;
    setFile({ uri: await writeCache(fromByteArray(new Uint8Array(bytes)), 'video/mp4'), mimeType: 'video/mp4' });
  });
  const speak = () => run(async signal => {
    const result = await aiSpeech(api, prompt.trim(), voice, signal); if (signal.aborted) return;
    setFile({ uri: await writeCache(result.base64, result.mimeType), mimeType: result.mimeType });
  });
  const transcribe = () => run(async signal => {
    const picked = await DocumentPicker.getDocumentAsync({ type: 'audio/*', multiple: false, copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    try {
      if (asset.size && asset.size > MAX_TRANSCRIBE) throw new Error('Аудио для расшифровки — до 10 МБ.');
      const audio = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      if (audio.length > Math.ceil(MAX_TRANSCRIBE / 3) * 4) throw new Error('Аудио для расшифровки — до 10 МБ.');
      const text = await aiTranscribe(api, audio, signal); if (!signal.aborted) setTranscript(text);
    } finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {}); }
  });

  const title = mode === 'image' ? 'Картинка по описанию' : mode === 'video' ? 'Короткое видео по описанию' : mode === 'speech' ? 'Озвучка текста' : 'Расшифровка аудио в текст';
  const placeholder = mode === 'image' ? 'Например: кот-космонавт в стиле акварели' : mode === 'video' ? 'Например: рассвет над спокойным озером' : 'Текст, который нужно озвучить';
  const limit = mode === 'video' ? 2000 : 4000;
  return <GlassSurface radius={23} shadow={false} contentStyle={{ padding: 16, gap: 12 }}>
    <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{title}</Text>
    {mode === 'transcribe' ? <Text style={help}>Выбери аудиофайл до 10 МБ: MP3, M4A, WAV, OGG, FLAC или WebM. Файл уйдёт через твой сервер в FreeLLMAPI и выбранному им провайдеру.</Text> : <>
      <TextInput value={prompt} onChangeText={setPrompt} placeholder={placeholder} placeholderTextColor={t.muted} multiline maxLength={limit} editable={!busy} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} accessibilityLabel={title} style={{ minHeight: 70, maxHeight: 160, padding: 12, borderRadius: 16, backgroundColor: t.surface2, color: t.text, fontSize: 15, lineHeight: 21, textAlignVertical: 'top' }} />
      {mode === 'speech' ? <Chips items={VOICES} value={voice} onChange={setVoice} /> : null}
      {mode === 'video' ? <Chips items={[2, 4, 6, 8, 10].map(value => ({ id: String(value), label: `${value} с` }))} value={String(duration)} onChange={value => setDuration(Number(value))} /> : null}
    </>}
    {busy ? <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><ActivityIndicator color={t.accent} /><Text style={help}>{mode === 'video' ? 'Видео генерируется до 5 минут…' : 'AI работает…'}</Text></View>
      <Button secondary label="Отменить ожидание" icon="stop-outline" onPress={() => { controller.current?.abort(); controller.current = null; setBusy(false); }} />
    </View> : <Button
      label={mode === 'image' ? 'Создать картинку' : mode === 'video' ? 'Создать видео' : mode === 'speech' ? 'Озвучить' : 'Выбрать аудио и расшифровать'}
      icon={mode === 'transcribe' ? 'document-attach-outline' : 'sparkles-outline'}
      disabled={mode !== 'transcribe' && !prompt.trim()}
      onPress={() => void (mode === 'image' ? generateImage() : mode === 'video' ? generateVideo() : mode === 'speech' ? speak() : transcribe())} />}
    {error ? <Notice text={error} error /> : null}
    {file && mode === 'image' ? <View style={{ gap: 10 }}>
      <Image source={{ uri: file.uri }} style={{ width: '100%', aspectRatio: 1, borderRadius: 18, backgroundColor: t.surface2 }} resizeMode="contain" accessibilityLabel={`Картинка AI: ${prompt}`} />
      {via ? <Text style={help}>Модель: {via}</Text> : null}
      <Button secondary label="Сохранить или отправить" icon="share-outline" onPress={() => void share(file.uri, file.mimeType).catch(e => setError(e.message))} />
    </View> : null}
    {file && mode === 'video' ? <VideoResult uri={file.uri} onShare={() => void share(file.uri, file.mimeType).catch(e => setError(e.message))} /> : null}
    {file && mode === 'speech' ? <AudioResult uri={file.uri} onShare={() => void share(file.uri, file.mimeType).catch(e => setError(e.message))} /> : null}
    {transcript && mode === 'transcribe' ? <View style={{ gap: 9 }}>
      <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 22, padding: 12, borderRadius: 14, backgroundColor: t.surface2 }}>{transcript}</Text>
      <Button secondary label="Скопировать текст" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(transcript)} />
    </View> : null}
  </GlassSurface>;
}

function Chips({ items, value, onChange }: { items: { id: string; label: string }[]; value: string; onChange: (value: string) => void }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{items.map(item => {
    const selected = item.id === value;
    return <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => onChange(item.id)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: selected ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: selected ? t.accent : t.border }}><Text style={{ color: selected ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{item.label}</Text></Pressable>;
  })}</View>;
}

function VideoResult({ uri, onShare }: { uri: string; onShare: () => void }) {
  const player = useVideoPlayer(uri, value => { value.loop = true; });
  return <View style={{ gap: 10 }}>
    <VideoView player={player} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 16 }} contentFit="contain" nativeControls allowsPictureInPicture={false} />
    <Button secondary label="Сохранить или отправить" icon="share-outline" onPress={onShare} />
  </View>;
}

function AudioResult({ uri, onShare }: { uri: string; onShare: () => void }) {
  const t = useTheme(); const player = useAudioPlayer(uri); const status = useAudioPlayerStatus(player);
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? 'Пауза' : 'Слушать'} onPress={() => { if (status.playing) player.pause(); else { if (status.didJustFinish || (status.duration && status.currentTime >= status.duration)) void player.seekTo(0); player.play(); } }} style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name={status.playing ? 'pause' : 'play'} size={22} color={t.onAccent} /></Pressable>
    <Text style={{ flex: 1, color: t.muted, fontSize: 12 }}>{status.duration ? `${Math.round(status.currentTime)} / ${Math.round(status.duration)} с` : 'Готово'}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Сохранить или отправить" onPress={onShare} style={{ padding: 10 }}><Icon name="share-outline" size={22} color={t.accent} /></Pressable>
  </View>;
}
