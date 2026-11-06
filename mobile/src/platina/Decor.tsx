import { CodeFrame, isCodeFrame } from './CodeFrames';
import { Text } from '../typography';
import { isBirthdayToday } from '../birthday';
import { useNetworkTier } from '../network/useNetworkTier';
import { autoload } from '../network/quality';
import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { Image as CachedImage } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { Api } from '../api';
import type { User } from '../types';
import { AuthImage, Avatar } from '../components';
import { MusicAmbient, type AmbientTone } from '../music/MusicAmbient';
import { useMotion } from '../motion';
import { useTheme } from '../theme';
import { DecorationArt, findDecoration } from './Decorations';

/** Platina avatar frames: a gradient ring that slowly turns around the avatar. */
export const FRAMES: { id: string; label: string; colors: string[] }[] = [
  { id: 'platinum', label: 'Платина', colors: ['#FFFFFF', '#8D97AA', '#F1F4F9', '#6C7588', '#FFFFFF', '#A7B0C1', '#FFFFFF'] },
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
/**
 * PC (Electron): a plain <video> cannot send the account token, so the file is fetched through the
 * app's own authenticated channel (as AuthImage does for pictures) and played from memory.
 */
const webVideoCache = new Map<string, Promise<string>>();
function webVideoUrl(api: Api, id: string) {
  let url = webVideoCache.get(id);
  if (!url) { url = fetch(api.fileUrl(id), { headers: { Authorization: `Bearer ${api.token}` } }).then(r => { if (!r.ok) throw new Error('video'); return r.blob(); }).then(blob => URL.createObjectURL(blob)); url.catch(() => webVideoCache.delete(id)); webVideoCache.set(id, url); }
  return url;
}
function WebLoopVideo({ api, id, uri, style }: { api?: Api; id?: string; uri?: string; style: Record<string, unknown> }) {
  const [src, setSrc] = useState<string | null>(uri ?? null);
  useEffect(() => { if (uri) { setSrc(uri); return; } let alive = true; if (api && id) webVideoUrl(api, id).then(url => { if (alive) setSrc(url); }).catch(() => {}); return () => { alive = false; }; }, [api?.token, id, uri]);
  if (!src) return null;
  return React.createElement('video', { src, autoPlay: true, muted: true, loop: true, playsInline: true, disablePictureInPicture: true, style: { objectFit: 'cover', pointerEvents: 'none', ...style } });
}

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
/** `round`: a circle instead of the rounded square (profiles, like Telegram). */
export function DecoratedAvatar({ user, api, size = 54, animated = false, round = false }: { user: User; api: Api; size?: number; animated?: boolean; round?: boolean }) {
  const t = useTheme(); const { enabled } = useMotion();
  // Platina without a chosen frame wears the platinum ring. On their birthday everyone wears a festive
  // ring — blue for «male», pink for «female», confetti colours otherwise — with a cake badge.
  const birthday = isBirthdayToday(user.birthday);
  const frame = birthday ? { id: 'birthday', colors: birthdayColors(user.gender) } : FRAMES.find(item => item.id === (user.avatarFrame || (user.seal === 'platina' ? 'platinum' : '')));
  // On a slow link (EDGE/3G) a looping video avatar would eat the bandwidth messages need.
  const tier = useNetworkTier();
  const live = animated && enabled && autoload('animatedAvatar', tier);
  const video = live && user.avatarVideoId ? user.avatarVideoId : null;
  const decoration = birthday ? undefined : findDecoration(user.avatarFrame);
  const coded = !birthday && isCodeFrame(user.avatarFrame) ? user.avatarFrame : null;
  // Small (list) sizes: the art may reach at most 1.3× the avatar box so it does not cover the
  // neighbouring rows; the photo shrinks inside to keep filling the opening.
  const face = decoration && size < 64 && decoration.scale > 1.3 ? Math.round(size * 1.3 / decoration.scale) : size;
  const inner = <View style={{ width: face, height: face }}>
    <Avatar user={user} api={api} size={face} round={round || !!decoration || !!coded} />
    {video ? Platform.OS === 'web' ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: decoration || round ? face / 2 : face * .36, overflow: 'hidden' }]}><WebLoopVideo api={api} id={video} style={{ width: face, height: face }} /></View> : <VideoAvatar api={api} id={video} size={face} radius={decoration ? face / 2 : face * .36} /> : null}
  </View>;
  // Frames drawn in code (neon, flame, stardust…): around a round avatar, outside its box like the art.
  if (coded) return <View style={{ width: size, height: size }}>{inner}<CodeFrame id={coded} size={size} live={live} /></View>;
  // Art decorations draw outside the avatar box (overflow), so rows keep their layout.
  if (decoration) return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    {inner}
    <View pointerEvents="none" style={{ position: 'absolute', left: (size - face) / 2, top: (size - face) / 2, width: face, height: face }}><DecorationArt decoration={decoration} size={face} live={live} /></View>
  </View>;
  if (!frame) return inner;
  const ring = Math.max(2, Math.round(size * .045)); const gap = Math.max(1.5, Math.round(size * .035));
  const outer = size + 2 * (ring + gap);
  // The frame grows outwards so lists keep their layout: negative margins cancel the extra size.
  return <View style={{ width: outer, height: outer, margin: -(ring + gap), alignItems: 'center', justifyContent: 'center' }}>
    <Spin size={outer} radius={round ? outer / 2 : outer * .36} colors={frame.colors} still={!live} />
    <View style={{ position: 'absolute', left: ring, top: ring, width: size + 2 * gap, height: size + 2 * gap, borderRadius: round ? (size + 2 * gap) / 2 : (size + 2 * gap) * .36, backgroundColor: t.bg }} />
    {inner}
    {birthday ? <View pointerEvents="none" accessibilityLabel="День рождения" style={{ position: 'absolute', right: 0, bottom: 0, width: Math.max(16, size * .34), height: Math.max(16, size * .34), borderRadius: size, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: Math.max(10, size * .22) }}>🎂</Text></View> : null}
  </View>;
}

function VideoBanner({ api, id }: { api: Api; id: string }) {
  const player = useVideoPlayer({ uri: api.fileUrl(id), headers: { Authorization: `Bearer ${api.token}` } }, value => { value.loop = true; value.muted = true; value.play(); });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />;
}

/** Soft top and bottom edges (Telegram-like): `blurred` shows only near the edges, the sharp layer in between. */
const EdgeBlur = ({ children }: { children: React.ReactNode }) => <MaskedView pointerEvents="none" style={StyleSheet.absoluteFill} maskElement={<LinearGradient colors={['#000', 'transparent', 'transparent', '#000']} locations={[0, 0.3, 0.55, 1]} style={StyleSheet.absoluteFill} />}>{children}</MaskedView>;

function LocalVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, value => { value.loop = true; value.muted = true; value.play(); });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />;
}

/** The phone-proportioned head of a profile (banner height 200 under a ~59 pt status bar). */
export const HERO_RATIO = 259 / 393;

/**
 * Profile banner: uploaded photo / video, or an animated preset. Null when there is none.
 * `local` shows a file picked on this device before it is uploaded (the «how it will look» preview).
 */
export function ProfileBanner({ user, api, height, width: fixedWidth, preview, local }: { user: Pick<User, 'bannerId' | 'bannerKind' | 'bannerPreset'>; api: Api; height: number; width?: number; preview?: boolean; local?: { uri: string; video: boolean } }) {
  const { width: screen } = useWindowDimensions(); const { enabled: motion } = useMotion(); const t = useTheme();
  const tier = useNetworkTier(); const enabled = motion && autoload('video', tier);
  const width = fixedWidth ?? screen;
  const soft = !preview && Platform.OS !== 'web';
  let content: React.ReactNode = null;
  if (local?.video && Platform.OS === 'web') content = <WebLoopVideo uri={local.uri} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
  else if (local?.video) content = <><LocalVideo uri={local.uri} />{soft && Platform.OS === 'ios' ? <EdgeBlur><BlurView intensity={40} tint="default" style={StyleSheet.absoluteFill} /></EdgeBlur> : null}</>;
  else if (local) content = <><CachedImage source={{ uri: local.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />{soft ? <EdgeBlur><CachedImage source={{ uri: local.uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={22} /></EdgeBlur> : null}</>;
  else if (user.bannerId && user.bannerKind === 'video' && enabled && Platform.OS === 'web') content = <WebLoopVideo api={api} id={user.bannerId} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
  else if (user.bannerId && user.bannerKind === 'video' && enabled) content = <>
    <VideoBanner api={api} id={user.bannerId} />
    {/* iOS blurs live content natively; Android keeps the plain video. */}
    {soft && Platform.OS === 'ios' ? <EdgeBlur><BlurView intensity={40} tint="default" style={StyleSheet.absoluteFill} /></EdgeBlur> : null}
  </>;
  else if (user.bannerId) content = <>
    <AuthImage api={api} id={user.bannerId} style={StyleSheet.absoluteFill} />
    {soft ? <EdgeBlur><AuthImage api={api} id={user.bannerId} style={StyleSheet.absoluteFill} blurRadius={22} /></EdgeBlur> : null}
  </>;
  else if (user.bannerPreset && BANNERS.some(item => item.id === user.bannerPreset)) content = <MusicAmbient width={width} height={height} tone={user.bannerPreset as AmbientTone} still={!enabled} />;
  if (!content) return null;
  const body = <View pointerEvents="none" style={{ width, height, overflow: 'hidden', backgroundColor: t.surface2 }}>{content}</View>;
  if (preview) return body;
  // The banner fades out by transparency, not into a flat colour: the page behind is a gradient,
  // so fading «to t.bg» left a visible seam where the banner ended (iPhone, dark theme).
  if (Platform.OS !== 'web') return <MaskedView pointerEvents="none" style={{ width, height }} maskElement={<LinearGradient colors={['#000', '#000', 'transparent']} locations={[0, 0.5, 1]} style={{ width, height }} />}>{body}</MaskedView>;
  return <View pointerEvents="none" style={{ width, height }}>{body}<LinearGradient colors={['transparent', t.bg]} locations={[0.55, 1]} style={StyleSheet.absoluteFill} /></View>;
}

/** Festive ring colours for a birthday: blue (male), pink (female), or bright confetti. */
export function birthdayColors(gender: string | null | undefined): string[] {
  if (gender === 'male') return ['#2F7BFF', '#7CC4FF', '#BFE6FF', '#4A8CFF', '#2F7BFF'];
  if (gender === 'female') return ['#FF5FA2', '#FFB3D6', '#FFD6E9', '#FF7EB8', '#FF5FA2'];
  return ['#FF5F6D', '#FFC371', '#7CE38B', '#5FA8FF', '#C38BFF', '#FF5F6D'];
}
