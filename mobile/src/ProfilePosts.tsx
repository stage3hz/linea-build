// Telegram «Публикации» and «Истории» on a profile: photos and videos the person pins to it. Seen by
// friends only (the server checks); a story disappears after 24 hours. The owner adds them from the
// gallery and removes one by holding it. Tapping opens it full screen; stories play one after another
// with bars at the top, like Telegram.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import { Text } from './typography';
import { AuthImage, Bouncy, Button, Field, Icon, Notice, Sheet, SheetAction } from './components';
import { useTheme } from './theme';
import type { Api, ProfileGift, ProfilePost, ProfilePosts } from './api';

type PostsData = ProfilePosts & { gifts: ProfileGift[] };

/** Gifts (Telegram «Подарки»): the ids the server knows (server/src/cosmetics.js GIFTS). */
export const GIFTS: { id: string; emoji: string; label: string; colors: [string, string] }[] = [
  { id: 'bear', emoji: '🧸', label: 'Мишка', colors: ['#C98B5A', '#7A4B2A'] }, { id: 'rose', emoji: '🌹', label: 'Роза', colors: ['#E0465E', '#7C1730'] },
  { id: 'cake', emoji: '🎂', label: 'Торт', colors: ['#F59BC0', '#A64D79'] }, { id: 'bouquet', emoji: '💐', label: 'Букет', colors: ['#F7A8C4', '#8C3D6B'] },
  { id: 'rocket', emoji: '🚀', label: 'Ракета', colors: ['#5B7CFA', '#20307A'] }, { id: 'trophy', emoji: '🏆', label: 'Кубок', colors: ['#F2C14E', '#8A5A12'] },
  { id: 'diamond', emoji: '💎', label: 'Бриллиант', colors: ['#7FD6F5', '#2A6E9E'] }, { id: 'champagne', emoji: '🍾', label: 'Шампанское', colors: ['#B9D67A', '#4E6B22'] },
  { id: 'present', emoji: '🎁', label: 'Подарок', colors: ['#F26D6D', '#8E2433'] }, { id: 'ring', emoji: '💍', label: 'Кольцо', colors: ['#D9D3F5', '#6B5FA8'] },
  { id: 'unicorn', emoji: '🦄', label: 'Единорог', colors: ['#D59BF6', '#6A3C9E'] }, { id: 'star', emoji: '⭐', label: 'Звезда', colors: ['#FFD86B', '#B5761B'] },
  { id: 'heart', emoji: '❤️', label: 'Сердце', colors: ['#FF6B81', '#9E1B3A'] }, { id: 'crown', emoji: '👑', label: 'Корона', colors: ['#F5CE5A', '#7E5A10'] },
  { id: 'fire', emoji: '🔥', label: 'Огонь', colors: ['#FF9A3D', '#A1300F'] }, { id: 'balloon', emoji: '🎈', label: 'Шарик', colors: ['#FF7A7A', '#A32F4C'] },
];
const giftOf = (id: string) => GIFTS.find(gift => gift.id === id) ?? { id, emoji: '🎁', label: 'Подарок', colors: ['#8E8E93', '#3A3A3C'] as [string, string] };

/** Background patterns of the profile header (server/src/cosmetics.js PROFILE_PATTERNS). */
export const PROFILE_PATTERNS = ['⭐', '❤️', '🌸', '🔥', '🌙', '⚡', '🍀', '🎵', '👑', '💎', '🦋', '🐾', '☁️', '❄️', '🌊', '🍒', '👻', '💀', '🎮', '🚀', '🌈', '🍕', '🐱', '🦊'];

/**
 * Telegram's profile background pattern: the chosen emoji repeated in rings around the avatar, smaller
 * and fainter further out. `cx`/`cy`: the avatar centre inside a box `width` × `height`.
 */
export function ProfilePattern({ emoji, width, height, cx, cy }: { emoji: string | null | undefined; width: number; height: number; cx: number; cy: number }) {
  if (!emoji || !width) return null;
  const rings = [{ r: 84, n: 6, size: 20, o: 0.3 }, { r: 124, n: 9, size: 17, o: 0.18 }, { r: 166, n: 12, size: 14, o: 0.1 }];
  return <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden' }}>
    {rings.flatMap((ring, k) => Array.from({ length: ring.n }, (_, i) => {
      const a = (i / ring.n) * Math.PI * 2 + k * 0.4; const x = cx + Math.cos(a) * ring.r * 1.3; const y = cy + Math.sin(a) * ring.r * 0.72;
      // Clear of the name and «в сети» under the photo.
      if (y > cy + 50 && Math.abs(x - cx) < 110) return null;
      if (y < -ring.size || y > height + ring.size || x < -ring.size || x > width + ring.size) return null;
      return <Text key={`${k}-${i}`} raw style={{ position: 'absolute', left: x - ring.size / 2, top: y - ring.size / 2, fontSize: ring.size, lineHeight: ring.size * 1.2, opacity: ring.o }}>{emoji}</Text>;
    }))}
  </View>;
}

const STORY_PHOTO_MS = 5000;
const message = (failure: unknown, fallback: string) => failure instanceof Error && failure.message ? failure.message : fallback;

/** Loads a person's posts and stories; `reload` after a change. */
export function useProfilePosts(api: Api, userId: string | null | undefined) {
  const [data, setData] = useState<PostsData | null>(null);
  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const [posts, gifts] = await Promise.all([api.profilePosts(userId), api.profileGifts(userId).catch(() => ({ visible: false, gifts: [] as ProfileGift[] }))]);
      setData({ ...posts, gifts: gifts.gifts });
    } catch { setData(previous => previous ?? { visible: false, posts: [], stories: [], gifts: [] }); }
  }, [api, userId]);
  useEffect(() => { setData(null); void reload(); }, [reload]);
  return { data, reload, setData };
}

/** Round avatar ring of Telegram stories: a bright gradient when there are stories to watch. */
export function StoryRing({ active, size, children }: { active: boolean; size: number; children: React.ReactNode }) {
  const t = useTheme();
  if (!active) return <>{children}</>;
  return <View style={{ width: size + 12, height: size + 12, alignItems: 'center', justifyContent: 'center' }}>
    <LinearGradient colors={['#5EE0A0', '#3BA4F5', '#8B5CF6']} start={{ x: 0, y: 1 }} end={{ x: 1, y: 0 }} style={[StyleSheet.absoluteFill, { borderRadius: (size + 12) / 2 }]} />
    <View style={{ position: 'absolute', width: size + 6, height: size + 6, borderRadius: (size + 6) / 2, backgroundColor: t.bg }} />
    {children}
  </View>;
}

async function pickAndUpload(api: Api): Promise<string | null> {
  if (Platform.OS !== 'web') { const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('Разреши доступ к фото и видео в настройках телефона.'); }
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsEditing: false, quality: 1, exif: false, videoMaxDuration: 60,
    videoExportPreset: ImagePicker.VideoExportPreset.H264_960x540, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  if (asset.type === 'video') {
    if ((asset.duration || 0) > 60_500) throw new Error('Видео — не длиннее минуты.');
    return (await api.upload({ uri: asset.uri, name: 'post.mp4', mimeType: asset.mimeType || 'video/mp4', size: asset.fileSize })).id;
  }
  // A photo is kept up to 1600 px across: sharp on any phone and under the 4 MB profile limit.
  const small = await ImageManipulator.manipulateAsync(asset.uri, (asset.width || 0) > 1600 ? [{ resize: { width: 1600 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 });
  return (await api.upload({ uri: small.uri, name: 'post.jpg', mimeType: 'image/jpeg' })).id;
}

const thumbs = new Map<string, string>();
function VideoThumb({ api, id, size }: { api: Api; id: string; size: number }) {
  const [uri, setUri] = useState(thumbs.get(id) ?? null);
  useEffect(() => {
    if (uri || Platform.OS === 'web') return; let live = true;
    VideoThumbnails.getThumbnailAsync(api.fileUrl(id), { time: 0, headers: { Authorization: `Bearer ${api.token}` } })
      .then(result => { thumbs.set(id, result.uri); if (live) setUri(result.uri); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return uri ? <Image source={{ uri }} style={{ width: size, height: size }} contentFit="cover" /> : <View style={{ width: size, height: size, backgroundColor: '#1A1D24' }} />;
}

function Tile({ api, post, size, onPress, onLongPress }: { api: Api; post: ProfilePost; size: number; onPress: () => void; onLongPress?: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={post.media.isVideo ? 'Видео' : 'Фото'} onPress={onPress} onLongPress={onLongPress} delayLongPress={350}
    style={({ pressed }) => ({ width: size, height: size, overflow: 'hidden', backgroundColor: '#1A1D24', opacity: pressed ? .8 : 1 })}>
    {post.media.isVideo ? <VideoThumb api={api} id={post.media.id} size={size} /> : <AuthImage api={api} id={post.media.id} style={{ width: size, height: size }} />}
    {post.media.isVideo ? <View style={{ position: 'absolute', right: 6, bottom: 6 }}><Icon name="play" size={16} color="#FFF" /></View> : null}
  </Pressable>;
}

/**
 * The tabs «Публикации» / «Истории» under the profile info, as in Telegram. `own`: the person's own
 * profile (add and remove). `width`: the width available for the grid.
 */
export function PostsSection({ api, own, data, onChanged, width, userId }: { api: Api; own: boolean; data: PostsData | null; onChanged: () => void; width: number; userId?: string }) {
  const t = useTheme();
  const [tab, setTab] = useState<'post' | 'story' | 'gift'>('post');
  const [giftSheet, setGiftSheet] = useState(false); const [hiding, setHiding] = useState<ProfileGift | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [viewer, setViewer] = useState<{ kind: 'post' | 'story'; index: number } | null>(null);
  const [removing, setRemoving] = useState<ProfilePost | null>(null);
  const items = tab === 'post' ? data?.posts ?? [] : tab === 'story' ? data?.stories ?? [] : [];
  const gifts = data?.gifts ?? []; const postTab: 'post' | 'story' = tab === 'story' ? 'story' : 'post';
  const add = async (kind: 'post' | 'story') => {
    if (busy) return; setError(''); setBusy(true);
    try { const uploadId = await pickAndUpload(api); if (uploadId) { await api.publishPost(uploadId, kind); onChanged(); } }
    catch (failure) { setError(message(failure, kind === 'post' ? 'Не удалось добавить публикацию.' : 'Не удалось добавить историю.')); }
    finally { setBusy(false); }
  };
  const remove = async (post: ProfilePost) => {
    setRemoving(null); setError('');
    try { await api.deletePost(post.id); onChanged(); } catch (failure) { setError(message(failure, 'Не удалось удалить.')); }
  };
  const gap = 2; const columns = 3; const size = Math.floor((width - gap * (columns - 1)) / columns);
  const tabButton = (id: 'post' | 'story' | 'gift', label: string, count: number) => { const on = tab === id; return <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(id)}
    style={{ flex: 1, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? (t.dark ? 'rgba(255,255,255,0.14)' : '#FFFFFF') : 'transparent' }}>
    <Text style={{ color: on ? t.text : t.muted, fontSize: 15, fontWeight: on ? '700' : '600' }}>{count ? `${label} ${count}` : label}</Text>
  </Pressable>; };

  if (data && !data.visible) return <View style={{ alignItems: 'center', paddingVertical: 22, gap: 6 }}>
    <Icon name="lock-closed-outline" size={22} color={t.muted} />
    <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center' }}>Публикации и истории видны только друзьям</Text>
  </View>;

  return <View style={{ gap: 14 }}>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', alignSelf: 'center', width: Math.min(420, width), padding: 4, borderRadius: 23, backgroundColor: t.dark ? '#1C1C1E' : 'rgba(127,127,127,0.12)' }}>
      {tabButton('post', 'Публикации', data?.posts.length ?? 0)}{tabButton('story', 'Истории', data?.stories.length ?? 0)}{tabButton('gift', 'Подарки', gifts.length)}
    </View>
    {error ? <Notice text={error} error /> : null}
    {tab === 'gift' && data ? <View style={{ gap: 12 }}>
      {!own && userId ? <Bouncy scaleTo={.96} accessibilityRole="button" onPress={() => setGiftSheet(true)} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 38, borderRadius: 19, backgroundColor: t.dark ? '#1C1C1E' : 'rgba(127,127,127,0.12)' }}>
        <Text style={{ fontSize: 17 }}>🎁</Text><Text style={{ color: t.accent, fontSize: 15, fontWeight: '600' }}>Отправить подарок</Text>
      </Bouncy> : null}
      {gifts.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{gifts.map(item => { const g = giftOf(item.gift); const w = Math.floor((width - 16) / 3); return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${g.label}${item.sender ? ` от ${item.sender.displayName}` : ''}`} onLongPress={own ? () => setHiding(item) : undefined} delayLongPress={350} style={{ width: w, borderRadius: 16, overflow: 'hidden' }}>
        <LinearGradient colors={g.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ alignItems: 'center', paddingVertical: 14, paddingHorizontal: 6, gap: 6 }}>
          <Text style={{ fontSize: 42, lineHeight: 50 }}>{g.emoji}</Text>
          <Text raw numberOfLines={1} style={{ color: '#FFF', fontSize: 12, fontWeight: '700' }}>{item.sender ? item.sender.displayName : g.label}</Text>
          {item.message ? <Text raw numberOfLines={2} style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, textAlign: 'center' }}>{item.message}</Text> : null}
        </LinearGradient>
      </Pressable>; })}</View> : <View style={{ alignItems: 'center', gap: 8, paddingVertical: 18 }}>
        <Text style={{ fontSize: 54 }}>🎁</Text>
        <Text style={{ color: t.text, fontSize: 19, fontWeight: '700' }}>Подарков пока нет…</Text>
        <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center' }}>{own ? 'Здесь появятся подарки от друзей.' : 'Подари первым — подарок появится в профиле.'}</Text>
      </View>}
    </View> : !data ? <ActivityIndicator color={t.muted} style={{ paddingVertical: 24 }} /> : items.length ? <View style={{ gap: 10 }}>
      {own ? <Bouncy scaleTo={.96} accessibilityRole="button" disabled={busy} onPress={() => void add(postTab)} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 38, borderRadius: 19, backgroundColor: t.dark ? '#1C1C1E' : 'rgba(127,127,127,0.12)' }}>
        {busy ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name="add" size={18} color={t.accent} />}
        <Text style={{ color: t.accent, fontSize: 15, fontWeight: '600' }}>{tab === 'post' ? 'Добавить публикацию' : 'Добавить историю'}</Text>
      </Bouncy> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, borderRadius: 14, overflow: 'hidden' }}>
        {items.map((post, index) => <Tile key={post.id} api={api} post={post} size={size} onPress={() => setViewer({ kind: postTab, index })} onLongPress={own ? () => setRemoving(post) : undefined} />)}
      </View>
    </View> : <View style={{ alignItems: 'center', gap: 8, paddingVertical: 18, paddingHorizontal: 12 }}>
      <Text style={{ fontSize: 54 }}>{tab === 'post' ? '🖼️' : '✨'}</Text>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: '700', textAlign: 'center' }}>{tab === 'post' ? 'Публикаций пока нет…' : 'Историй пока нет…'}</Text>
      <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>{own ? (tab === 'post' ? 'Публикуйте фотографии и видео в своём профиле. Их видят друзья.' : 'История видна друзьям 24 часа, потом исчезает.') : (tab === 'post' ? 'Здесь появятся фото и видео.' : 'Сейчас историй нет.')}</Text>
      {own ? <View style={{ alignSelf: 'stretch', marginTop: 8, paddingHorizontal: 30 }}><Button label={tab === 'post' ? 'Добавить публикацию' : 'Добавить историю'} loading={busy} onPress={() => void add(postTab)} /></View> : null}
    </View>}
    {userId ? <GiftSheet api={api} userId={userId} visible={giftSheet} onClose={() => setGiftSheet(false)} onSent={() => { setGiftSheet(false); onChanged(); }} /> : null}
    <Sheet visible={!!hiding} title="Подарок" onClose={() => setHiding(null)}>
      <SheetAction icon="eye-off-outline" label="Убрать из профиля" description="Подарок исчезнет из профиля." danger onPress={() => { const item = hiding; setHiding(null); if (item) api.removeGift(item.id).then(onChanged, failure => setError(message(failure, 'Не удалось убрать подарок.'))); }} />
    </Sheet>
    <Sheet visible={!!removing} title={removing?.kind === 'story' ? 'История' : 'Публикация'} onClose={() => setRemoving(null)}>
      <SheetAction icon="trash-outline" label="Удалить" description="Исчезнет из профиля у всех." danger onPress={() => { if (removing) void remove(removing); }} />
    </Sheet>
    {viewer && data ? <PostViewer api={api} items={viewer.kind === 'post' ? data.posts : data.stories} start={viewer.index} story={viewer.kind === 'story'} onClose={() => setViewer(null)} /> : null}
  </View>;
}

function Media({ api, post, active, width, height, onEnd }: { api: Api; post: ProfilePost; active: boolean; width: number; height: number; onEnd?: () => void }) {
  if (post.media.isVideo && Platform.OS !== 'web') return <VideoMedia api={api} id={post.media.id} active={active} width={width} height={height} onEnd={onEnd} />;
  return <AuthImage api={api} id={post.media.id} style={{ width, height }} resizeMode="contain" />;
}
function VideoMedia({ api, id, active, width, height, onEnd }: { api: Api; id: string; active: boolean; width: number; height: number; onEnd?: () => void }) {
  const player = useVideoPlayer({ uri: api.fileUrl(id), headers: { Authorization: `Bearer ${api.token}` } }, value => { value.loop = !onEnd; });
  useEffect(() => { if (active) { player.currentTime = 0; player.play(); } else player.pause(); }, [active, player]);
  useEffect(() => { if (!onEnd) return; const sub = player.addListener('playToEnd', () => onEnd()); return () => sub.remove(); }, [player, onEnd]);
  return <VideoView player={player} style={{ width, height }} contentFit="contain" nativeControls={false} allowsPictureInPicture={false} />;
}

/** Full screen: posts swipe sideways; stories play in turn (5 s a photo, a video to its end), tap the right side for the next, the left for the previous. */
export function PostViewer({ api, items, start, story, onClose }: { api: Api; items: ProfilePost[]; start: number; story: boolean; onClose: () => void }) {
  const { width, height } = useWindowDimensions(); const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(Math.min(start, Math.max(0, items.length - 1)));
  const progress = useSharedValue(0); const closing = useRef(false);
  const current = items[index];
  const next = useCallback(() => { setIndex(i => { if (i + 1 >= items.length) { if (!closing.current) { closing.current = true; setTimeout(onClose, 0); } return i; } return i + 1; }); }, [items.length, onClose]);
  const previous = () => setIndex(i => Math.max(0, i - 1));
  useEffect(() => {
    if (!story || !current) return;
    cancelAnimation(progress); progress.value = 0;
    if (current.media.isVideo && Platform.OS !== 'web') return; // a video moves on when it ends
    progress.value = withTiming(1, { duration: STORY_PHOTO_MS, easing: Easing.linear }, done => { if (done) runOnJS(next)(); });
    return () => cancelAnimation(progress);
  }, [index, story]);
  const bar = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  if (!current) return null;
  const when = new Date(current.createdAt); const ago = Math.max(0, Math.round((Date.now() - when.getTime()) / 3_600_000));
  return <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait']}>
    <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <Media key={current.id} api={api} post={current} active width={width} height={height * 0.82} onEnd={story ? next : undefined} />
      {/* Tap zones: left third back, the rest forward (stories and posts alike). */}
      <View style={[StyleSheet.absoluteFill, { flexDirection: 'row' }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Предыдущее" style={{ flex: 1 }} onPress={previous} />
        <Pressable accessibilityRole="button" accessibilityLabel="Следующее" style={{ flex: 2 }} onPress={() => { if (index + 1 < items.length) setIndex(index + 1); else if (story) next(); }} />
      </View>
      <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 10, right: 10, gap: 10 }}>
        {story || items.length > 1 ? <View style={{ flexDirection: 'row', gap: 4 }}>{items.map((item, i) => <View key={item.id} style={{ flex: 1, height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.3)' }}>
          {i < index ? <View style={{ flex: 1, backgroundColor: '#FFF' }} /> : i === index ? (story ? <Animated.View style={[{ height: 3, backgroundColor: '#FFF' }, bar]} /> : <View style={{ flex: 1, backgroundColor: '#FFF' }} />) : null}
        </View>)}</View> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{story ? (ago < 1 ? 'только что' : `${ago} ч назад`) : `${index + 1} из ${items.length}`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose} hitSlop={10} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' }}><Icon name="close" size={22} color="#FFF" /></Pressable>
        </View>
      </View>
      {current.caption ? <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 24 }}><Text raw style={{ color: '#FFF', fontSize: 16, lineHeight: 22, textAlign: 'center' }}>{current.caption}</Text></View> : null}
    </View>
  </Modal>;
}

/** Choose a gift for a friend, add a short note, send. */
function GiftSheet({ api, userId, visible, onClose, onSent }: { api: Api; userId: string; visible: boolean; onClose: () => void; onSent: () => void }) {
  const t = useTheme(); const [picked, setPicked] = useState('bear'); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const send = async () => { if (busy) return; setBusy(true); setError(''); try { await api.sendGift(userId, picked, note.trim()); setNote(''); onSent(); } catch (failure) { setError(message(failure, 'Не удалось отправить подарок.')); } finally { setBusy(false); } };
  return <Sheet visible={visible} title="Подарок" onClose={onClose}><View style={{ gap: 14 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>{GIFTS.map(g => { const on = g.id === picked; return <Pressable key={g.id} accessibilityRole="radio" accessibilityLabel={g.label} accessibilityState={{ checked: on }} onPress={() => setPicked(g.id)} style={{ width: 70, borderRadius: 16, overflow: 'hidden', borderWidth: 2, borderColor: on ? t.accent : 'transparent' }}>
      <LinearGradient colors={g.colors} style={{ alignItems: 'center', paddingVertical: 8, gap: 2 }}><Text style={{ fontSize: 30, lineHeight: 36 }}>{g.emoji}</Text><Text style={{ color: '#FFF', fontSize: 10, fontWeight: '700' }}>{g.label}</Text></LinearGradient>
    </Pressable>; })}</View>
    <Field label="Подпись" value={note} onChangeText={setNote} placeholder="Необязательно" maxLength={120} />
    {error ? <Notice text={error} error /> : null}
    <Button label="Отправить подарок" loading={busy} onPress={() => void send()} />
  </View></Sheet>;
}
