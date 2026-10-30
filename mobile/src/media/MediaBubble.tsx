// Media inside a message, as in Telegram: photos load by themselves and show
// in full right in the chat; videos and files show a ring with progress and
// open instantly once loaded. Tapping during a download cancels it.
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle } from 'react-native-svg';
import { Text } from '../typography';
import { Icon, type IconName } from '../components';
import { formatSize, useTheme } from '../theme';
import type { Api } from '../api';
import type { Attachment } from '../types';
import { mediaPreviewKind } from './formats';
import { previewUri } from './previewModel';
import { useMedia } from './mediaCache';
import { lightFeedback } from '../haptics';

/** Photos up to this size load automatically (Telegram's default is similar). */
export const AUTO_PHOTO_BYTES = 10 * 1024 * 1024;

export function ProgressRing({ progress, size = 46, color = '#FFF', track = 'rgba(255,255,255,0.25)', width = 3 }: { progress: number; size?: number; color?: string; track?: string; width?: number }) {
  const r = (size - width) / 2, c = 2 * Math.PI * r, value = Math.max(0.03, Math.min(1, progress));
  return <Svg width={size} height={size} style={{ position: 'absolute' }}>
    <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={width} fill="none" />
    <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={width} fill="none" strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - value)} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
  </Svg>;
}

const clock = (ms = 0) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Fits the original aspect ratio into the bubble (Telegram keeps proportions). */
export function mediaBox(attachment: Attachment, maxWidth = 250, maxHeight = 330) {
  const w = attachment.media?.width || attachment.preview?.width || 4, h = attachment.media?.height || attachment.preview?.height || 3;
  const ratio = Math.max(0.45, Math.min(2.2, w / h));
  let width = maxWidth, height = width / ratio;
  if (height > maxHeight) { height = maxHeight; width = height * ratio; }
  return { width: Math.round(Math.max(150, width)), height: Math.round(Math.max(110, height)) };
}

/** One photo or video tile; used alone and inside an album grid. */
export function MediaTile({ api, attachment, width, height, radius = 16, onOpen, onLongPress }: { api: Api; attachment: Attachment; width: number; height: number; radius?: number; onOpen: () => void; onLongPress?: () => void }) {
  const kind = mediaPreviewKind(attachment), photo = kind === 'photo';
  const media = useMedia(api, attachment, photo && attachment.size <= AUTO_PHOTO_BYTES);
  const thumb = useMemo(() => previewUri(attachment.preview), [attachment.preview]);
  const press = () => {
    if (media.status === 'loading') { lightFeedback(); media.cancel(); return; }
    if (media.status === 'ready') { onOpen(); return; }
    lightFeedback();
    // A video opens by itself once loaded; a photo simply appears in the bubble.
    void media.start().then(() => { if (!photo) onOpen(); }).catch(() => {});
  };
  return <Pressable onPress={press} onLongPress={onLongPress} delayLongPress={450} accessibilityRole="button" accessibilityLabel={`${photo ? 'Фото' : 'Видео'}${media.status === 'loading' ? `, загрузка ${Math.round(media.progress * 100)}%` : ''}`} style={{ width, height, borderRadius: radius, overflow: 'hidden', backgroundColor: 'rgba(120,130,160,0.18)' }}>
    {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={photo ? 12 : 0} /> : null}
    {photo && media.status === 'ready' && media.uri ? <Image source={{ uri: media.uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={180} /> : null}
    {!photo || media.status !== 'ready' ? <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(10,15,30,0.55)', alignItems: 'center', justifyContent: 'center' }}>
        {media.status === 'loading' ? <><ProgressRing progress={media.progress} size={48} /><Icon name="close" size={22} color="#FFF" /></> : <Icon name={media.status === 'error' ? 'refresh' : photo ? 'arrow-down' : 'play'} size={24} color="#FFF" />}
      </View>
    </View> : null}
    {!photo || media.status !== 'ready' ? <View style={{ position: 'absolute', left: 7, top: 7, flexDirection: 'row', gap: 4 }}>
      <Text style={{ color: '#FFF', fontSize: 11, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(10,15,30,0.55)' }}>
        {media.status === 'loading' ? `${formatSize(attachment.size * media.progress)} / ${formatSize(attachment.size)}` : !photo ? `${clock(attachment.media?.durationMs)}${media.status === 'ready' ? '' : ` · ${formatSize(attachment.size)}`}` : formatSize(attachment.size)}
      </Text>
    </View> : null}
  </Pressable>;
}

/** Photos/videos sent together, laid out in rows like Telegram albums. */
export function AlbumGrid({ api, items, width, onOpen, onLongPress }: { api: Api; items: Attachment[]; width: number; onOpen: (attachment: Attachment) => void; onLongPress?: () => void }) {
  const gap = 2;
  const rows: Attachment[][] = [];
  const n = items.length;
  // 2 → 1 row; 3 → 1 big + 2; 4 → 2+2; 5 → 2+3; 6 → 3+3; larger: rows of 3 (last row 2–4).
  const plan = n === 2 ? [2] : n === 3 ? [1, 2] : n === 4 ? [2, 2] : n === 5 ? [2, 3] : n === 6 ? [3, 3] : n === 7 ? [3, 4] : n === 8 ? [2, 3, 3] : n === 9 ? [3, 3, 3] : [3, 3, 4];
  let index = 0;
  for (const count of plan) { rows.push(items.slice(index, index + count)); index += count; }
  return <View style={{ width, gap, borderRadius: 16, overflow: 'hidden' }}>
    {rows.map((row, r) => {
      const height = row.length === 1 ? width * 0.62 : row.length === 2 ? width * 0.48 : width * 0.33;
      const tile = (width - gap * (row.length - 1)) / row.length;
      return <View key={r} style={{ flexDirection: 'row', gap }}>{row.map(item => <MediaTile key={item.id} api={api} attachment={item} width={tile} height={height} radius={0} onOpen={() => onOpen(item)} onLongPress={onLongPress} />)}</View>;
    })}
  </View>;
}

const fileIcon = (attachment: Attachment): IconName => {
  const kind = mediaPreviewKind(attachment);
  if (kind === 'audio') return 'musical-notes';
  if (/pdf$/i.test(attachment.name)) return 'document-text';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(attachment.name)) return 'archive';
  return 'document';
};

/** A document row with Telegram's round button: ↓, a progress ring, then the file icon. */
export function FileBubble({ api, attachment, onOpen }: { api: Api; attachment: Attachment; onOpen: () => void }) {
  const t = useTheme(); const media = useMedia(api, attachment);
  const press = () => {
    if (media.status === 'loading') { lightFeedback(); media.cancel(); return; }
    if (media.status === 'ready') { onOpen(); return; }
    lightFeedback(); void media.start().then(() => onOpen()).catch(() => {});
  };
  const ext = (attachment.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toUpperCase();
  return <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={`${attachment.name}, ${formatSize(attachment.size)}${media.status === 'loading' ? `, загрузка ${Math.round(media.progress * 100)}%` : media.status === 'ready' ? ', загружен' : ''}`} style={({ pressed }) => ({ flexDirection: 'row', gap: 11, alignItems: 'center', paddingVertical: 4, minWidth: 200, maxWidth: 270, opacity: pressed ? .75 : 1 })}>
    <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
      {media.status === 'loading' ? <><ProgressRing progress={media.progress} size={48} color={t.onAccent} track="rgba(255,255,255,0.3)" /><Icon name="close" size={20} color={t.onAccent} /></> : media.status === 'ready' ? <Icon name={fileIcon(attachment)} size={22} color={t.onAccent} /> : <Icon name={media.status === 'error' ? 'refresh' : 'arrow-down'} size={22} color={t.onAccent} />}
    </View>
    <View style={{ flex: 1, gap: 3 }}>
      <Text numberOfLines={2} style={{ fontSize: 14, fontWeight: '600', color: t.text }}>{attachment.name}</Text>
      <Text style={{ fontSize: 12, color: media.status === 'error' ? t.danger : t.muted }}>{media.status === 'loading' ? `${formatSize(attachment.size * media.progress)} из ${formatSize(attachment.size)}` : media.status === 'error' ? 'Ошибка · нажми, чтобы повторить' : `${formatSize(attachment.size)}${ext ? ` · ${ext}` : ''}`}</Text>
    </View>
  </Pressable>;
}
