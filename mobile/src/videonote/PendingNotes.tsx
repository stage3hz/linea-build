// Circles on their way out, under the newest message (Telegram): the frame from the take with an upload ring
// and ✕ while sending; after a failure a «!» circle with the reason, «Повторить отправку» and «Удалить».
import React, { useSyncExternalStore } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Pressable, Text } from '../typography';
import { Icon } from '../components';
import { useTheme } from '../theme';
import { ProgressRing } from '../media/MediaBubble';
import { getNotes, notesFor, subscribeNotes, type NoteUpload } from './noteOutbox';

const SIDE = 212;

export function useNoteUploads(chatId: string): NoteUpload[] {
  const all = useSyncExternalStore(subscribeNotes, getNotes, getNotes);
  return React.useMemo(() => notesFor(all, chatId), [all, chatId]);
}

export function PendingNotes({ notes, onRetry, onDiscard }: { notes: NoteUpload[]; onRetry: (id: string) => void; onDiscard: (id: string) => void }) {
  if (!notes.length) return null;
  return <View>{notes.map(note => <PendingNote key={note.id} note={note} onRetry={onRetry} onDiscard={onDiscard} />)}</View>;
}

function LocalLoop({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, value => { value.loop = true; value.muted = true; value.audioMixingMode = 'mixWithOthers'; value.play(); });
  return <VideoView player={player} pointerEvents="none" style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} surfaceType="textureView" />;
}

function PendingNote({ note, onRetry, onDiscard }: { note: NoteUpload; onRetry: (id: string) => void; onDiscard: (id: string) => void }) {
  const t = useTheme(); const failed = note.state === 'failed';
  return <Animated.View entering={FadeIn.duration(150)} style={{ alignSelf: 'flex-end', alignItems: 'flex-end', marginVertical: 6 }}>
    <View style={{ width: SIDE, height: SIDE, borderRadius: SIDE / 2, overflow: 'hidden', backgroundColor: '#11162A', alignItems: 'center', justifyContent: 'center' }}>
      {/* Telegram: the circle being sent already plays (silently, in a loop) from the recording itself, in full
          quality; the frame under it shows until the player has drawn. */}
      {note.thumb ? <Image source={{ uri: note.thumb }} style={[StyleSheet.absoluteFill, failed ? { opacity: .55 } : null]} resizeMode="cover" fadeDuration={0} /> : null}
      {!failed && Platform.OS !== 'web' ? <LocalLoop uri={note.uri} /> : null}
      {failed
        ? <Pressable accessibilityRole="button" accessibilityLabel="Повторить отправку" onPress={() => onRetry(note.id)} hitSlop={8} style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(10,20,35,0.6)', alignItems: 'center', justifyContent: 'center' }}><Icon name="refresh" size={26} color="#FFF" /></Pressable>
        : <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(10,20,35,0.6)', alignItems: 'center', justifyContent: 'center' }}>
          {/* Cleaning and encrypting report no bytes yet: a spinner until the upload itself moves. */}
          {note.progress > 0 ? <ProgressRing progress={note.progress} size={56} /> : <ActivityIndicator style={StyleSheet.absoluteFill} color="rgba(255,255,255,0.8)" />}
          <Pressable accessibilityRole="button" accessibilityLabel="Не отправлять видеосообщение" onPress={() => onDiscard(note.id)} hitSlop={8}><Icon name="close" size={24} color="#FFF" /></Pressable>
        </View>}
    </View>
    {failed ? <View style={{ maxWidth: 260, paddingTop: 6, gap: 3, alignItems: 'flex-end' }}>
      <Text style={{ fontSize: 11, color: t.danger, fontWeight: '600' }}>Видеосообщение не отправлено</Text>
      {note.error ? <Text style={{ fontSize: 10, lineHeight: 14, color: t.muted, textAlign: 'right' }}>{note.error}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 16, paddingTop: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => onDiscard(note.id)} hitSlop={8}><Text style={{ fontSize: 13, color: t.muted, fontWeight: '600' }}>Удалить</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => onRetry(note.id)} hitSlop={8}><Text style={{ fontSize: 13, color: t.accent, fontWeight: '600' }}>Повторить отправку</Text></Pressable>
      </View>
    </View> : null}
  </Animated.View>;
}
