import React, { useEffect } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { Api } from '../api';
import type { User } from '../types';
import { AuthImage, Avatar } from '../components';
import { MusicAmbient, type AmbientTone } from '../music/MusicAmbient';
import { useMotion } from '../motion';
import { useTheme } from '../theme';

/** Platina avatar frames: a gradient ring that slowly turns around the avatar. */
export const FRAMES: { id: string; label: string; colors: string[] }[] = [
  { id: 'aurora', label: 'Сияние', colors: ['#3FA9F5', '#2EE6C8', '#E8F6FF', '#3FA9F5'] },
  { id: 'frost', label: 'Иней', colors: ['#BFE6FF', '#FFFFFF', '#6FB6FF', '#BFE6FF'] },
  { id: 'ember', label: 'Пламя', colors: ['#FF4D3A', '#FFC24B', '#FF2E63', '#FF4D3A'] },
  { id: 'emerald', label: 'Изумруд', colors: ['#0BAA6F', '#8CF7CF', '#0B6450', '#0BAA6F'] },
  { id: 'prism', label: 'Призма', colors: ['#4F8CFF', '#2EE6C8', '#FFE066', '#FF6B8A', '#4F8CFF'] },
  { id: 'orbit', label: 'Орбита', colors: ['#16316A', '#4F8CFF', '#16316A', '#16316A'] },
];

/** Animated banner presets; the colours live in MusicAmbient's palettes. */
export const BANNERS: { id: AmbientTone; label: string }[] = [
  { id: 'deep', label: 'Глубина' }, { id: 'glacier', label: 'Ледник' }, { id: 'aurora', label: 'Сияние' },
  { id: 'ocean', label: 'Океан' }, { id: 'mint', label: 'Мята' }, { id: 'night', label: 'Ночь' },
];

function Spin({ size, radius, colors, still }: { size: number; radius: number; colors: string[]; still: boolean }) {
  const angle = useSharedValue(0);
  useEffect(() => {
    if (still) { cancelAnimation(angle); angle.value = 0; return; }
    angle.value = 0; angle.value = withRepeat(withTiming(360, { duration: 5200, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(angle);
  }, [still]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  const big = size * 1.5;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
    <Animated.View style={[{ position: 'absolute', width: big, height: big, left: (size - big) / 2, top: (size - big) / 2 }, spin]}>
      <LinearGradient colors={colors as [string, string, ...string[]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  </View>;
}

/** The video avatar: silent loop, cached by the player, the photo shows until the first frame. */
function VideoAvatar({ api, id, size, radius }: { api: Api; id: string; size: number; radius: number }) {
  const player = useVideoPlayer({ uri: api.fileUrl(id), headers: { Authorization: `Bearer ${api.token}` } }, value => { value.loop = true; value.muted = true; value.play(); });
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
    <VideoView player={player} style={{ width: size, height: size }} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />
  </View>;
}

/**
 * Avatar with Platina decoration. `animated` turns on the video avatar and the frame motion;
 * lists pass false and get the still photo with a still frame (cheap to scroll).
 */
export function DecoratedAvatar({ user, api, size = 54, animated = false }: { user: User; api: Api; size?: number; animated?: boolean }) {
  const t = useTheme(); const { enabled } = useMotion();
  const frame = FRAMES.find(item => item.id === user.avatarFrame);
  const live = animated && enabled;
  const video = live && user.avatarVideoId && Platform.OS !== 'web' ? user.avatarVideoId : null;
  const inner = <View style={{ width: size, height: size }}>
    <Avatar user={user} api={api} size={size} />
    {video ? <VideoAvatar api={api} id={video} size={size} radius={size * .36} /> : null}
  </View>;
  if (!frame) return inner;
  const ring = Math.max(2, Math.round(size * .045)); const gap = Math.max(1.5, Math.round(size * .035));
  const outer = size + 2 * (ring + gap);
  // The frame grows outwards so lists keep their layout: negative margins cancel the extra size.
  return <View style={{ width: outer, height: outer, margin: -(ring + gap), alignItems: 'center', justifyContent: 'center' }}>
    <Spin size={outer} radius={outer * .36} colors={frame.colors} still={!live} />
    <View style={{ position: 'absolute', left: ring, top: ring, width: size + 2 * gap, height: size + 2 * gap, borderRadius: (size + 2 * gap) * .36, backgroundColor: t.bg }} />
    {inner}
  </View>;
}

function VideoBanner({ api, id }: { api: Api; id: string }) {
  const player = useVideoPlayer({ uri: api.fileUrl(id), headers: { Authorization: `Bearer ${api.token}` } }, value => { value.loop = true; value.muted = true; value.play(); });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />;
}

/** Profile banner: uploaded photo / video, or an animated preset. Null when there is none. */
export function ProfileBanner({ user, api, height, width: fixedWidth, preview }: { user: Pick<User, 'bannerId' | 'bannerKind' | 'bannerPreset'>; api: Api; height: number; width?: number; preview?: boolean }) {
  const { width: screen } = useWindowDimensions(); const { enabled } = useMotion(); const t = useTheme();
  const width = fixedWidth ?? screen;
  let content: React.ReactNode = null;
  if (user.bannerId && user.bannerKind === 'video' && enabled && Platform.OS !== 'web') content = <VideoBanner api={api} id={user.bannerId} />;
  else if (user.bannerId) content = <AuthImage api={api} id={user.bannerId} style={StyleSheet.absoluteFill} />;
  else if (user.bannerPreset && BANNERS.some(item => item.id === user.bannerPreset)) content = <MusicAmbient width={width} height={height} tone={user.bannerPreset as AmbientTone} still={!enabled} />;
  if (!content) return null;
  return <View pointerEvents="none" style={{ width, height, overflow: 'hidden', backgroundColor: t.surface2 }}>
    {content}
    {preview ? null : <LinearGradient colors={['transparent', t.bg]} locations={[0.55, 1]} style={StyleSheet.absoluteFill} />}
  </View>;
}
