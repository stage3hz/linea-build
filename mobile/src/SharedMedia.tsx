import React, { useMemo, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Text } from './typography';
import { Icon } from './components';
import { formatSize, useTheme } from './theme';
import type { Attachment } from './types';
import type { ViewMessage } from './messageMeta';
import { mediaPreviewKind } from './media/formats';
import { previewUri } from './media/previewModel';
import { isVideoNote, isVoice } from './voice/voice';

type Tab = 'media' | 'files' | 'voice' | 'links';
const URL = /https?:\/\/[^\s<>"']+/gi;
const when = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Profile tabs with everything shared in the chat (Медиа · Файлы · Голосовые · Ссылки), from
 * the decrypted history on this device — nothing is asked from the server.
 */
export function SharedMedia({ messages, onOpen }: { messages: ViewMessage[]; onOpen: (attachment: Attachment) => void }) {
  const t = useTheme(); const { width } = useWindowDimensions();
  const groups = useMemo(() => {
    const media: { a: Attachment; m: ViewMessage }[] = [], files: typeof media = [], voice: typeof media = [], links: { url: string; m: ViewMessage }[] = [];
    for (const m of [...messages].reverse()) {
      const a = m.attachment;
      if (a) {
        if (isVoice(a) || isVideoNote(a)) voice.push({ a, m });
        else if (['photo', 'video'].includes(mediaPreviewKind(a))) media.push({ a, m });
        else files.push({ a, m });
      }
      for (const url of m.text?.match(URL) || []) links.push({ url: url.replace(/[).,!?»]+$/, ''), m });
    }
    return { media, files, voice, links };
  }, [messages]);
  const tabs: { id: Tab; label: string; count: number }[] = ([
    { id: 'media', label: 'Медиа', count: groups.media.length }, { id: 'files', label: 'Файлы', count: groups.files.length },
    { id: 'voice', label: 'Голосовые', count: groups.voice.length }, { id: 'links', label: 'Ссылки', count: groups.links.length },
  ] as const).filter(tab => tab.count > 0);
  const [tab, setTab] = useState<Tab | null>(null);
  const active = tab && tabs.some(item => item.id === tab) ? tab : tabs[0]?.id;
  if (!active) return null;
  const cell = Math.floor((Math.min(width, 600) - 36 - 4) / 3);
  return <View style={{ alignSelf: 'stretch', gap: 10 }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, padding: 4, borderRadius: 18, backgroundColor: t.surface2 }}>
      {tabs.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: item.id === active }} onPress={() => setTab(item.id)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: item.id === active ? t.accentSoft : 'transparent' }}>
        <Text style={{ color: item.id === active ? t.accent : t.text, fontSize: 14, fontWeight: '600' }}>{item.label}</Text>
      </Pressable>)}
    </ScrollView>
    {active === 'media' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, borderRadius: 14, overflow: 'hidden' }}>
      {groups.media.map(({ a }) => { const thumb = previewUri(a.preview); const seconds = Math.floor((a.media?.durationMs || 0) / 1000);
        return <Pressable key={a.id} onPress={() => onOpen(a)} style={{ width: cell, height: cell, backgroundColor: t.surface2 }}>
          {thumb ? <Image source={{ uri: thumb }} style={{ width: cell, height: cell }} resizeMode="cover" /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Icon name="image-outline" color={t.muted} /></View>}
          {mediaPreviewKind(a) === 'video' ? <Text style={{ position: 'absolute', left: 5, bottom: 5, color: '#FFF', fontSize: 11, fontWeight: '600', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.5)' }}>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</Text> : null}
        </Pressable>; })}
    </View> : null}
    {active === 'files' || active === 'voice' ? <View style={{ borderRadius: 16, backgroundColor: t.surface2, paddingVertical: 4 }}>
      {(active === 'files' ? groups.files : groups.voice).map(({ a, m }) => <Pressable key={a.id} onPress={() => onOpen(a)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 9, opacity: pressed ? .6 : 1 })}>
        <View style={{ width: 42, height: 42, borderRadius: active === 'voice' ? 21 : 10, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}><Icon name={active === 'voice' ? (isVideoNote(a) ? 'videocam' : 'play') : 'document-text'} size={20} color={t.onAccent} /></View>
        <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{active === 'voice' ? (isVideoNote(a) ? 'Видеосообщение' : 'Голосовое сообщение') : a.name}</Text><Text style={{ color: t.muted, fontSize: 12 }}>{formatSize(a.size)} · {when(m.createdAt)}</Text></View>
      </Pressable>)}
    </View> : null}
    {active === 'links' ? <View style={{ borderRadius: 16, backgroundColor: t.surface2, paddingVertical: 4 }}>
      {groups.links.map(({ url, m }, index) => <Pressable key={`${m.id}-${index}`} onPress={() => void Linking.openURL(url).catch(() => {})} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 9, opacity: pressed ? .6 : 1 })}>
        <View style={{ width: 42, height: 42, borderRadius: 10, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.accent, fontSize: 17, fontWeight: '700' }}>{(url.replace(/^https?:\/\/(www\.)?/, '')[0] || '?').toUpperCase()}</Text></View>
        <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: t.accent, fontSize: 14 }}>{url.replace(/^https?:\/\//, '')}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{m.text}</Text></View>
      </Pressable>)}
    </View> : null}
  </View>;
}
