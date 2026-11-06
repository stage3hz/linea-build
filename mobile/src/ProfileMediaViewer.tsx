// Telegram: tapping a profile photo (or pulling the profile down) opens the person's photos and videos
// full screen — swipe sideways between them, «1 из 2» at the top. Here: the profile video and photo.
import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './typography';
import { AuthImage, Icon } from './components';
import type { Api } from './api';
import type { User } from './types';

export type ProfileMedia = { kind: 'photo' | 'video'; id: string };

export function profileMedia(user: Pick<User, 'avatarId' | 'avatarVideoId'>): ProfileMedia[] {
  return [...(user.avatarVideoId && Platform.OS !== 'web' ? [{ kind: 'video' as const, id: user.avatarVideoId }] : []), ...(user.avatarId ? [{ kind: 'photo' as const, id: user.avatarId }] : [])];
}

function VideoPage({ api, id, active, width, height }: { api: Api; id: string; active: boolean; width: number; height: number }) {
  const player = useVideoPlayer({ uri: api.fileUrl(id), headers: { Authorization: `Bearer ${api.token}` } }, value => { value.loop = true; value.muted = false; });
  React.useEffect(() => { if (active) player.play(); else player.pause(); }, [active, player]);
  return <VideoView player={player} style={{ width, height }} contentFit="contain" nativeControls={false} allowsPictureInPicture={false} />;
}

export function ProfileMediaViewer({ api, user, start, onClose }: { api: Api; user: User; start: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const items = profileMedia(user); const [index, setIndex] = useState(Math.min(start, Math.max(0, items.length - 1)));
  if (!items.length) return null;
  return <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait']}>
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} contentOffset={{ x: index * width, y: 0 }}
        onMomentumScrollEnd={e => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))} style={StyleSheet.absoluteFill}>
        {items.map((item, i) => <View key={item.id} style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
          {item.kind === 'video' ? <VideoPage api={api} id={item.id} active={i === index} width={width} height={width} /> : <AuthImage api={api} id={item.id} style={{ width, height: width }} resizeMode="contain" />}
        </View>)}
      </ScrollView>
      <View style={{ position: 'absolute', top: insets.top + 8, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose} hitSlop={10} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' }}><Icon name="chevron-back" size={24} color="#FFF" /></Pressable>
        <View style={{ flex: 1, alignItems: 'center', marginRight: 44 }}>
          <Text raw numberOfLines={1} style={{ color: '#FFF', fontSize: 16, fontWeight: '700' }}>{user.displayName}</Text>
          {items.length > 1 ? <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{`${index + 1} из ${items.length}`}</Text> : null}
        </View>
      </View>
      {items.length > 1 ? <View style={{ position: 'absolute', top: insets.top + 60, left: 12, right: 12, flexDirection: 'row', gap: 4 }}>{items.map((item, i) => <View key={item.id} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i === index ? '#FFF' : 'rgba(255,255,255,0.35)' }} />)}</View> : null}
    </View>
  </Modal>;
}
