import React, { memo, useEffect, useRef, useState } from 'react';
import { FormattedText } from './format/FormattedText';
import { endsInBlock } from './format/render';
import { ActivityIndicator, Keyboard, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeInDown, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from './typography';
import { AttachmentCard, Icon } from './components';
import { formatDay, formatTime, useTheme } from './theme';
import type { Api } from './api';
import type { Attachment, PendingMessage } from './types';
import type { Reaction, StoryRef, ViewMessage } from './messageMeta';
import { VoiceBubble } from './voice/VoiceMessage';
import { isVideoNote, isVoice } from './voice/voice';
import { VideoNoteBubble } from './videonote/VideoNote';
import { impactFeedback, lightFeedback } from './haptics';
import { AlbumGrid, FileBubble, MediaTile, captionedMediaBox, mediaBox } from './media/MediaBubble';
import { mediaPreviewKind } from './media/formats';
import { PollBubble } from './PollBubble';
import { bigEmojiCount } from './messageMeta';
import { AnimatedEmoji, bigEmoji } from './platina/AnimatedEmoji';
import { InviteCard } from './communities/InviteCard';
import { inviteCodeFrom, withoutInviteLink } from './communities/types';
import { navigate } from './navigation';

export type AlbumPart = { attachment: Attachment; message?: ViewMessage; pending?: PendingMessage };
export type Row = { key: string; message?: ViewMessage; pending?: PendingMessage; createdAt: string; album?: AlbumPart[]; missing?: number };

/** Messages sent before this device joined cannot be decrypted here (end-to-end): one calm line instead of a wall of them. */
export const MissingRow = memo(function MissingRow({ count }: { count: number }) {
  const t = useTheme();
  const word = count % 10 === 1 && count % 100 !== 11 ? 'сообщение' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'сообщения' : 'сообщений';
  return <View accessible accessibilityLabel={`${count} ${word} до входа на этом устройстве`} style={{ alignSelf: 'center', maxWidth: 360, marginVertical: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: t.dark ? 'rgba(12,15,24,0.72)' : 'rgba(255,255,255,0.82)', flexDirection: 'row', gap: 10, alignItems: 'center' }}>
    <Icon name="lock-closed-outline" size={16} color={t.text} />
    <Text style={{ flexShrink: 1, color: t.text, fontSize: 13, lineHeight: 18 }}>{count} {word} до входа на этом устройстве. Они зашифрованы для других твоих устройств и здесь не открываются.</Text>
  </View>;
});
export type RowHandlers = {
  actions: (row: Row, y: number, x?: number) => void; jumpTo: (clientId: string) => void; open: (file: Attachment) => void;
  react: (message: ViewMessage, emoji: Reaction) => void; retry: (pending: PendingMessage) => void; cancel?: (pending: PendingMessage) => void; reply: (message: ViewMessage) => void;
  vote: (message: ViewMessage, options: number[]) => void; toggleSelect: (row: Row) => void;
  /** A tap on the «История» quote of an answer to a story: opens the author's stories (never a jump in the chat). */
  openStory?: (story: StoryRef) => void;
};
type Props = {
  row: Row; olderCreatedAt?: string; mine: boolean; author: string; peerLastRead: number; wide: boolean;
  fontSize: number; lineHeight: number; downloading: boolean; radius?: number; groupNext?: boolean; replyAuthor?: string; replyText?: string;
  api: Api; handlers: React.MutableRefObject<RowHandlers>; selecting: boolean; selected: boolean; fresh: boolean;
  /** Platina: large emoji-only messages play their animation. */
  animatedEmoji?: boolean;
};
const visualKind = (file: Attachment) => { const kind = mediaPreviewKind(file); return kind === 'photo' || kind === 'video'; };

/** Swipe a message to the LEFT to reply, as in Telegram for iPhone (a right swipe goes back).
 * Runs on the UI thread; a diagonal swipe works too, a mostly vertical one scrolls the list. */
function SwipeToReply({ enabled, onReply, children }: { enabled: boolean; onReply: () => void; children: React.ReactNode }) {
  const t = useTheme();
  const x = useSharedValue(0); const armed = useSharedValue(false);
  const reply = useRef(onReply); reply.current = onReply;
  const fire = () => reply.current();
  const pan = Gesture.Pan().enabled(enabled)
    .activeOffsetX(-10).failOffsetX(14).failOffsetY([-28, 28])
    .onBegin(() => { armed.value = false; })
    .onUpdate(event => {
      const value = Math.min(0, Math.max(-96, event.translationX * 0.85)); x.value = value;
      if (value <= -60 && !armed.value) { armed.value = true; runOnJS(lightFeedback)(); }
      else if (value > -60 && armed.value) armed.value = false;
    })
    .onEnd(() => { if (armed.value) runOnJS(fire)(); })
    .onFinalize(() => { x.value = withSpring(0, { damping: 18, stiffness: 260 }); });
  const bubble = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const icon = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-60, -12], [1, 0], 'clamp'), transform: [{ scale: interpolate(x.value, [-60, -12], [1, 0.6], 'clamp') }] }));
  return <GestureDetector gesture={pan}><View>
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', right: 4, top: 0, bottom: 8, justifyContent: 'center' }, icon]}>
      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-undo" size={17} color={t.accent} /></View>
    </Animated.View>
    <Animated.View style={bubble}>{children}</Animated.View>
  </View></GestureDetector>;
}

const megabytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ` : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0).replace('.', ',')} МБ`;

/** A big file on its way: Telegram-like progress with sent/total and a cancel button. */
function UploadBubble({ pending, onCancel }: { pending: PendingMessage; onCancel: () => void }) {
  const t = useTheme(); const upload = pending.upload!;
  const total = upload.total || pending.attachment?.size || 0; const fraction = total ? Math.min(1, upload.sent / total) : 0;
  const failed = pending.state === 'failed';
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, minWidth: 220, maxWidth: 280 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Отменить отправку" onPress={onCancel} hitSlop={6} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="close" size={22} color={t.onAccent} />
    </Pressable>
    <View style={{ flex: 1, gap: 5 }}>
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{pending.attachment?.name || 'Файл'}</Text>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: t.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)', overflow: 'hidden' }}><View style={{ width: `${Math.round(fraction * 100)}%`, height: 4, borderRadius: 2, backgroundColor: failed ? t.danger : t.accent }} /></View>
      <Text style={{ color: t.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{failed ? 'Остановлено' : upload.sent ? `${megabytes(upload.sent)} из ${megabytes(total)}` : `Шифрование · ${megabytes(total)}`}</Text>
    </View>
  </View>;
}

function MessageRowView({ row, olderCreatedAt, mine, author, peerLastRead, wide, fontSize, lineHeight, downloading, radius = 20, groupNext = false, replyAuthor, replyText, api, handlers, selecting, selected, fresh, animatedEmoji = false }: Props) {
  const t = useTheme(); const screenWidth = useWindowDimensions().width;
  // Phone layout on a wide screen (phone sideways): bubbles stop at 520 pt instead of stretching.
  const bubbleMax = !wide && screenWidth > 612 ? 520 : '85%';
  const message = row.message; const p = row.pending;
  // Mesh (no internet): bluetooth = a phone nearby took it, ✓✓ = it reached the person, accent ✓✓ = read.
  const meshMark = p?.mesh === 'handed' ? <Icon name="bluetooth" size={12} color={t.accent} /> : p?.mesh === 'delivered' ? <Icon name="checkmark-done" size={15} color={t.muted} /> : p?.mesh === 'read' ? <Icon name="checkmark-done" size={15} color={t.accent} /> : null;
  const poll = message?.meta?.poll || p?.meta?.poll;
  const rawBody = poll ? '' : message?.text || p?.text || ''; const invite = rawBody ? inviteCodeFrom(rawBody) : null; const body = invite ? withoutInviteLink(rawBody) : rawBody; const file = row.album ? null : message?.attachment || p?.attachment;
  // Formatting (bold, spoiler, quote…) came decrypted with the text; offsets refer to the full text, so a trimmed invite body is shown plain.
  const entities = invite ? undefined : message?.meta?.entities || p?.meta?.entities;
  const emoji = !file && !poll && !row.album ? bigEmojiCount(body) : 0;
  const animatedParts = emoji && animatedEmoji ? bigEmoji(body) : null;
  const visual = !!file && !p?.upload && visualKind(file) && !isVideoNote(file);
  const bare = (visual && !body) || !!row.album && !body || emoji > 0;
  // Telegram for iPhone (compact layout): media up to 300×380 pt, at least 170×74 pt, inset 2 pt inside the bubble.
  const mediaMax = Math.round(Math.min(wide ? 440 : 300, screenWidth - 2 * 36));
  const box = file && visual ? (body && !emoji ? captionedMediaBox(file, mediaMax, wide ? 440 : 380) : mediaBox(file, mediaMax, wide ? 440 : 380)) : null;
  const albumWidth = mediaMax;
  // Photo/video/album with a caption: the media fills the bubble edge to edge, the caption sits below (as in Telegram).
  const flush = !!body && !emoji && ((visual && !!box) || !!row.album);
  const flushWidth = row.album ? albumWidth : box?.width || 0;
  const pad = flush ? { paddingHorizontal: 12 } : null;
  // Telegram puts the time inside the last line of text; an invisible spacer reserves its place.
  // The spacer is #00000001, not 'transparent': on Android a nested span with colour 0 inherits the text colour.
  const circle = !!file && isVideoNote(file) && !body;
  // Telegram: reactions sit inside the bubble, next to the time.
  const reactionsInside = !!message?.reactions.length && !bare && !circle && !emoji;
  // A message that ends with a quote or code block has no last text line for the time to share.
  const inlineTime = !!body && !emoji && !reactionsInside && !(entities && endsInBlock(body, entities));
  const reactionChips = (inside: boolean) => message ? message.reactions.map(reaction => <Pressable key={reaction.emoji} accessibilityRole="button" accessibilityLabel={`Реакция ${reaction.emoji}: ${reaction.count}${reaction.mine ? ', твоя' : ''}`} onPress={() => handlers.current.react(message, reaction.emoji)} hitSlop={4}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 14, backgroundColor: reaction.mine ? t.accent : inside ? (t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)') : t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.7)', borderWidth: inside ? 0 : 1, borderColor: t.border }}>
    <Text style={{ fontSize: 15 }}>{reaction.emoji}</Text>{reaction.count > 1 ? <Text style={{ color: reaction.mine ? t.onAccent : t.text, fontSize: 12, fontWeight: '600' }}>{reaction.count}</Text> : null}</Pressable>) : null;
  const showDay = !olderCreatedAt || new Date(olderCreatedAt).toDateString() !== new Date(row.createdAt).toDateString();
  const reply = message?.meta?.reply || p?.meta?.reply;
  // An answer to a story carries the same quote block; a tap opens the story instead of jumping in the chat.
  const storyRef = message?.meta?.story || p?.meta?.story;
  const read = peerLastRead >= (message?.id || 0);
  // Telegram: a tap on a message (or next to it) opens reactions and actions, a double tap puts ❤️.
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);
  const decrypted = !!message && message.cryptoState === 'decrypted';
  const press = (pageY = 0) => {
    if (selecting) { lightFeedback(); handlers.current.toggleSelect(row); return; }
    if (!message && !p) return;
    // With the keyboard open, a tap on the list only hides the keyboard (as in Telegram).
    if (!tapTimer.current && Keyboard.isVisible()) { Keyboard.dismiss(); return; }
    if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = undefined; if (decrypted) { impactFeedback(); handlers.current.react(message!, '❤️'); } return; }
    tapTimer.current = setTimeout(() => { tapTimer.current = undefined; lightFeedback(); handlers.current.actions(row, pageY); }, 230);
  };
  // Desktop (Telegram Desktop / Discord): a click does nothing, a double click replies, the right
  // button opens the menu at the cursor, and hovering shows a small toolbar.
  const desktop = Platform.OS === 'web' && wide;
  const rootRef = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    const node = rootRef.current as unknown as HTMLElement | null;
    if (!desktop || !node?.addEventListener) return;
    const onMenu = (event: MouseEvent) => { if (!message && !p) return; event.preventDefault(); handlers.current.actions(row, event.clientY, event.clientX); };
    const onDouble = (event: MouseEvent) => { if (selecting || !decrypted) return; event.preventDefault(); window.getSelection?.()?.removeAllRanges(); handlers.current.reply(message!); };
    const enter = () => setHovered(true), leave = () => setHovered(false);
    node.addEventListener('contextmenu', onMenu); node.addEventListener('dblclick', onDouble); node.addEventListener('mouseenter', enter); node.addEventListener('mouseleave', leave);
    return () => { node.removeEventListener('contextmenu', onMenu); node.removeEventListener('dblclick', onDouble); node.removeEventListener('mouseenter', enter); node.removeEventListener('mouseleave', leave); };
  }, [desktop, row, message, p, selecting, decrypted]);
  const longPress = (pageY: number) => { if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = undefined; } if (selecting) { handlers.current.toggleSelect(row); return; } impactFeedback(); handlers.current.actions(row, pageY); };
  return <Animated.View entering={fresh ? FadeInDown.duration(220) : undefined}>
    {showDay ? <View style={{ alignSelf: 'center', backgroundColor: t.black ? 'rgba(0,0,0,0.68)' : t.dark ? 'rgba(30,36,53,0.68)' : 'rgba(255,255,255,0.52)', borderWidth: 1, borderColor: t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.88)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, marginTop: 15, marginBottom: 18 }}><Text style={{ color: t.muted, fontSize: 10, fontWeight: '600' }}>{formatDay(row.createdAt)}</Text></View> : null}
    <View ref={rootRef}>
    <Pressable onPress={event => desktop ? (selecting ? press() : undefined) : press(event.nativeEvent.pageY)} onLongPress={desktop ? undefined : event => longPress(event.nativeEvent.pageY)} delayLongPress={400} accessible={false} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: selected ? t.accentSoft : desktop && hovered ? (t.dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)') : 'transparent', borderRadius: 14, marginHorizontal: -6, paddingHorizontal: 6 }}>
    {selecting ? <View style={{ width: 30, alignItems: 'flex-start' }}><Icon name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={selected ? t.accent : t.subtle} /></View> : null}
    <View style={{ flex: 1 }}>
    <SwipeToReply enabled={!selecting && !!message && message.cryptoState === 'decrypted'} onReply={() => message && handlers.current.reply(message)}>
      <View pointerEvents={selecting ? 'box-only' : 'auto'} style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: groupNext ? 2 : 6 }}>
        {/* PC hover toolbar sits beside the bubble (Telegram Desktop), never over the text. */}
        <View style={{ width: '100%', flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'center', gap: 6 }}>
        {/* On PC the text is selectable with the mouse like in Telegram Desktop: holding the button no
            longer turns into a long press, and a click only acts while choosing messages. */}
        <Pressable onPress={event => desktop ? (selecting ? press() : undefined) : press(event.nativeEvent.pageY)} onLongPress={desktop ? undefined : event => longPress(event.nativeEvent.pageY)} delayLongPress={400} accessibilityLabel={`${author}: ${poll ? `Опрос: ${poll.question}` : body || file?.name || 'Вложение'}`} style={circle || emoji ? { maxWidth: bubbleMax } : bare ? { maxWidth: bubbleMax, borderRadius: 18, overflow: 'hidden', borderWidth: p?.state === 'failed' ? 1 : 0, borderColor: t.danger } : { maxWidth: wide ? '76%' : bubbleMax, minWidth: 60, ...(flush ? { width: flushWidth + 4, overflow: 'hidden' as const } : null), backgroundColor: mine ? t.bubble : t.incoming, borderRadius: radius, borderBottomRightRadius: mine && !groupNext ? Math.min(6, radius) : radius, borderBottomLeftRadius: !mine && !groupNext ? Math.min(6, radius) : radius, paddingHorizontal: flush ? 2 : 11, paddingTop: flush ? 2 : file ? 5 : 6, paddingBottom: inlineTime ? 6 : 5, borderWidth: p?.state === 'failed' ? 1 : 0, borderColor: t.danger }}>
          {message?.meta?.forward ? <Text style={[{ color: t.accent, fontSize: 11, fontWeight: '600', marginBottom: 4, paddingHorizontal: 1 }, flush ? { paddingHorizontal: 12, paddingTop: 7 } : null]}>{message.meta.forward.from ? `Переслано от ${message.meta.forward.from}` : 'Пересланное сообщение'}</Text> : null}
          {reply || storyRef ? <Pressable accessibilityRole="button" accessibilityLabel={storyRef ? 'Открыть историю' : 'Перейти к исходному сообщению'} onPress={() => storyRef ? handlers.current.openStory?.(storyRef) : reply ? handlers.current.jumpTo(reply.clientId) : undefined} style={{ flexDirection: 'row', gap: 7, marginBottom: 6, ...(flush ? { marginHorizontal: 8, marginTop: 8 } : null), paddingVertical: 5, paddingRight: 8, borderRadius: 10, backgroundColor: t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}><View style={{ width: 3, borderRadius: 2, backgroundColor: t.accent }} /><View style={{ flexShrink: 1, gap: 1 }}><Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{replyAuthor}</Text><Text numberOfLines={2} style={{ color: t.muted, fontSize: 12 }}>{replyText}</Text></View></Pressable> : null}
          {row.album ? <View style={{ marginBottom: body ? 7 : 0 }}><AlbumGrid api={api} items={row.album.map(part => part.attachment)} width={albumWidth} onOpen={attachment => selecting ? press() : handlers.current.open(attachment)} onLongPress={() => longPress(0)} /></View> : null}
          {file ? <View style={{ marginBottom: body ? 7 : bare ? 0 : 1, marginTop: bare || flush ? 0 : 1 }}>{p?.upload ? <UploadBubble pending={p} onCancel={() => handlers.current.cancel?.(p)} /> : isVoice(file) ? <VoiceBubble attachment={file} mine={mine} /> : isVideoNote(file) ? <VideoNoteBubble api={api} attachment={file} /> : visual && box ? <MediaTile api={api} attachment={file} width={box.width} height={box.height} radius={bare ? 15 : flush ? Math.max(4, radius - 3) : 14} onOpen={() => selecting ? press() : handlers.current.open(file)} onLongPress={() => longPress(0)} /> : file.encryption ? <FileBubble api={api} attachment={file} onOpen={() => handlers.current.open(file)} /> : <AttachmentCard api={api} attachment={file} onPress={() => handlers.current.open(file)} />}</View> : null}
          {poll ? <PollBubble poll={poll} results={message?.poll} disabled={!message || message.cryptoState !== 'decrypted' || selecting} onVote={options => message && handlers.current.vote(message, options)} /> : null}
          {animatedParts ? <View accessible accessibilityLabel={body} style={{ flexDirection: 'row', gap: 2 }}>{animatedParts.map((part, index) => <AnimatedEmoji key={`${index}${part}`} emoji={part} size={emoji === 1 ? 112 : emoji === 2 ? 84 : 68} mode="once" />)}</View> : body ? emoji ? <Text raw style={{ fontSize: emoji === 1 ? 64 : emoji === 2 ? 52 : 44, lineHeight: emoji === 1 ? 76 : emoji === 2 ? 62 : 54 }}>{body}</Text> : <FormattedText text={body} entities={entities} color={t.text} linkColor={mine ? t.text : t.accent} fontSize={fontSize} lineHeight={lineHeight} selectable={desktop} style={{ paddingHorizontal: flush ? 9 : 1 }} trailing={inlineTime ? <Text selectable={false} style={{ fontSize: 11, color: '#00000001', userSelect: 'none' } as any}>{`\u00A0\u00A0\u00A0${message?.edited ? 'изм. ' : ''}${formatTime(row.createdAt)}${mine ? '\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0' : ''}\u00A0`}</Text> : null} /> : null}
          {invite ? <View style={{ marginTop: 6, marginBottom: 2 }}><InviteCard api={api} code={invite} onOpen={code => navigate({ to: 'invite', code })} /></View> : null}
          {reactionsInside ? <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 6, paddingHorizontal: flush ? 12 : 0 }}><View style={{ flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>{reactionChips(true)}</View><View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4, paddingBottom: 1 }}>{downloading ? <ActivityIndicator color={t.accent} size="small" /> : null}<Text style={{ color: bare && !body ? '#FFF' : t.muted, fontSize: 11 }}>{message?.edited ? 'изм. ' : ''}{formatTime(row.createdAt)}</Text>{p || row.album?.some(part => part.pending) ? (p?.state === 'failed' || row.album?.some(part => part.pending?.state === 'failed')) ? <Icon name="alert-circle" size={13} color={t.danger} /> : (meshMark ?? <Icon name="time-outline" size={12} color={bare && !body ? '#FFF' : t.muted} />) : mine ? <Icon name={read ? 'checkmark-done' : 'checkmark'} size={15} color={bare && !body ? '#FFF' : read ? t.accent : t.muted} /> : null}</View></View> : <View style={inlineTime ? { position: 'absolute', right: 10, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4 } : bare && !body ? { position: 'absolute', right: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: 'rgba(10,15,30,0.5)' } : emoji ? { alignSelf: 'flex-end', marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: t.dark ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.85)' } : { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 5, marginTop: 4 }}>{downloading ? <ActivityIndicator color={t.accent} size="small" /> : null}<Text style={{ color: bare && !body ? '#FFF' : t.muted, fontSize: 11 }}>{message?.edited ? 'изм. ' : ''}{formatTime(row.createdAt)}</Text>{p || row.album?.some(part => part.pending) ? (p?.state === 'failed' || row.album?.some(part => part.pending?.state === 'failed')) ? <Icon name="alert-circle" size={13} color={t.danger} /> : (meshMark ?? <Icon name="time-outline" size={12} color={bare && !body ? '#FFF' : t.muted} />) : mine ? <Icon name={read ? 'checkmark-done' : 'checkmark'} size={15} color={bare && !body ? '#FFF' : read ? t.accent : t.muted} /> : null}</View>}
        </Pressable>
        {desktop && hovered && !selecting && (message || p) ? <View style={{ flexDirection: 'row', borderRadius: 12, padding: 2, backgroundColor: t.glassOpaque, borderWidth: 1, borderColor: t.border, shadowColor: '#000', shadowOpacity: .18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }}>
      {decrypted ? <HoverButton icon="happy-outline" label="Реакция" onPress={(x, y) => handlers.current.actions(row, y, x)} /> : null}
      {decrypted ? <HoverButton icon="arrow-undo-outline" label="Ответить" onPress={() => handlers.current.reply(message!)} /> : null}
      <HoverButton icon="ellipsis-horizontal" label="Ещё" onPress={(x, y) => handlers.current.actions(row, y, x)} />
        </View> : null}
        </View>
        {message?.reactions.length && !reactionsInside ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4, maxWidth: wide ? '76%' : bubbleMax, justifyContent: mine ? 'flex-end' : 'flex-start' }}>{reactionChips(false)}</View> : null}
        {p?.state === 'failed' ? <Pressable accessibilityRole="button" onPress={() => handlers.current.retry(p)} style={{ paddingVertical: 8, maxWidth: '85%', gap: 3 }}><Text style={{ fontSize: 11, color: t.danger, fontWeight: '600' }}>Не отправлено · повторить</Text>{p.error ? <Text style={{ fontSize: 10, lineHeight: 14, color: t.muted }}>{p.error}</Text> : null}</Pressable> : null}
      </View>
    </SwipeToReply>
    </View>
    </Pressable>
    </View>
  </Animated.View>;
}

/** Re-renders only when this row's own data changes, not on every keystroke in the composer. */
export const MessageRow = memo(MessageRowView);

function HoverButton({ icon, label, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; onPress: (x: number, y: number) => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={event => onPress(event.nativeEvent.pageX, event.nativeEvent.pageY)}
    style={state => ({ width: 32, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: (state as { hovered?: boolean }).hovered ? t.accentSoft : 'transparent' })}>
    <Icon name={icon} size={17} color={t.muted} />
  </Pressable>;
}
