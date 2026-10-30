import React, { memo, useEffect, useRef } from 'react';
import { ActivityIndicator, Keyboard, Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeInDown, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from './typography';
import { AttachmentCard, Icon } from './components';
import { formatDay, formatTime, useTheme } from './theme';
import type { Api } from './api';
import type { Attachment, PendingMessage } from './types';
import type { Reaction, ViewMessage } from './messageMeta';
import { VoiceBubble } from './voice/VoiceMessage';
import { isVideoNote, isVoice } from './voice/voice';
import { VideoNoteBubble } from './videonote/VideoNote';
import { impactFeedback, lightFeedback } from './haptics';
import { AlbumGrid, FileBubble, MediaTile, mediaBox } from './media/MediaBubble';
import { mediaPreviewKind } from './media/formats';
import { PollBubble } from './PollBubble';
import { bigEmojiCount } from './messageMeta';

export type AlbumPart = { attachment: Attachment; message?: ViewMessage; pending?: PendingMessage };
export type Row = { key: string; message?: ViewMessage; pending?: PendingMessage; createdAt: string; album?: AlbumPart[] };
export type RowHandlers = {
  actions: (row: Row, y: number) => void; jumpTo: (clientId: string) => void; open: (file: Attachment) => void;
  react: (message: ViewMessage, emoji: Reaction) => void; retry: (pending: PendingMessage) => void; reply: (message: ViewMessage) => void;
  vote: (message: ViewMessage, options: number[]) => void; toggleSelect: (row: Row) => void;
};
type Props = {
  row: Row; olderCreatedAt?: string; mine: boolean; author: string; peerLastRead: number; wide: boolean;
  fontSize: number; lineHeight: number; downloading: boolean; radius?: number; replyAuthor?: string; replyText?: string;
  api: Api; handlers: React.MutableRefObject<RowHandlers>; selecting: boolean; selected: boolean; fresh: boolean;
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

function MessageRowView({ row, olderCreatedAt, mine, author, peerLastRead, wide, fontSize, lineHeight, downloading, radius = 20, replyAuthor, replyText, api, handlers, selecting, selected, fresh }: Props) {
  const t = useTheme();
  const message = row.message; const p = row.pending;
  const poll = message?.meta?.poll || p?.meta?.poll;
  const body = poll ? '' : message?.text || p?.text || ''; const file = row.album ? null : message?.attachment || p?.attachment;
  const emoji = !file && !poll && !row.album ? bigEmojiCount(body) : 0;
  const visual = !!file && visualKind(file) && !isVideoNote(file);
  const bare = (visual && !body) || !!row.album && !body || emoji > 0;
  const box = file && visual ? mediaBox(file, wide ? 300 : 250) : null;
  const albumWidth = wide ? 320 : 260;
  // Photo/video/album with a caption: the media fills the bubble edge to edge, the caption sits below (as in Telegram).
  const flush = !!body && !emoji && ((visual && !!box) || !!row.album);
  const flushWidth = row.album ? albumWidth : box?.width || 0;
  const pad = flush ? { paddingHorizontal: 12 } : null;
  // Telegram puts the time inside the last line of text; an invisible spacer reserves its place.
  const circle = !!file && isVideoNote(file) && !body;
  // Telegram: reactions sit inside the bubble, next to the time.
  const reactionsInside = !!message?.reactions.length && !bare && !circle && !emoji;
  const inlineTime = !!body && !emoji && !reactionsInside;
  const reactionChips = (inside: boolean) => message ? message.reactions.map(reaction => <Pressable key={reaction.emoji} accessibilityRole="button" accessibilityLabel={`Реакция ${reaction.emoji}: ${reaction.count}${reaction.mine ? ', твоя' : ''}`} onPress={() => handlers.current.react(message, reaction.emoji)} hitSlop={4}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 14, backgroundColor: reaction.mine ? t.accent : inside ? (t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)') : t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.7)', borderWidth: inside ? 0 : 1, borderColor: t.border }}>
    <Text style={{ fontSize: 15 }}>{reaction.emoji}</Text>{reaction.count > 1 ? <Text style={{ color: reaction.mine ? t.onAccent : t.text, fontSize: 12, fontWeight: '600' }}>{reaction.count}</Text> : null}</Pressable>) : null;
  const showDay = !olderCreatedAt || new Date(olderCreatedAt).toDateString() !== new Date(row.createdAt).toDateString();
  const reply = message?.meta?.reply || p?.meta?.reply;
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
  const longPress = (pageY: number) => { if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = undefined; } if (selecting) { handlers.current.toggleSelect(row); return; } impactFeedback(); handlers.current.actions(row, pageY); };
  return <Animated.View entering={fresh ? FadeInDown.duration(220) : undefined}>
    {showDay ? <View style={{ alignSelf: 'center', backgroundColor: t.black ? 'rgba(0,0,0,0.68)' : t.dark ? 'rgba(30,36,53,0.68)' : 'rgba(255,255,255,0.52)', borderWidth: 1, borderColor: t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.88)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, marginTop: 15, marginBottom: 18 }}><Text style={{ color: t.muted, fontSize: 10, fontWeight: '600' }}>{formatDay(row.createdAt)}</Text></View> : null}
    <Pressable onPress={event => press(event.nativeEvent.pageY)} onLongPress={event => longPress(event.nativeEvent.pageY)} delayLongPress={400} accessible={false} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: selected ? t.accentSoft : 'transparent', borderRadius: 14, marginHorizontal: -6, paddingHorizontal: 6 }}>
    {selecting ? <View style={{ width: 30, alignItems: 'flex-start' }}><Icon name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={selected ? t.accent : t.subtle} /></View> : null}
    <View style={{ flex: 1 }}>
    <SwipeToReply enabled={!selecting && !!message && message.cryptoState === 'decrypted'} onReply={() => message && handlers.current.reply(message)}>
      <View pointerEvents={selecting ? 'box-only' : 'auto'} style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: 3 }}>
        <Pressable onPress={event => press(event.nativeEvent.pageY)} onLongPress={event => longPress(event.nativeEvent.pageY)} delayLongPress={400} accessibilityLabel={`${author}: ${poll ? `Опрос: ${poll.question}` : body || file?.name || 'Вложение'}`} style={circle || emoji ? { maxWidth: '85%' } : bare ? { maxWidth: '85%', borderRadius: 18, overflow: 'hidden', borderWidth: p?.state === 'failed' ? 1 : 0, borderColor: t.danger } : { maxWidth: wide ? '76%' : '85%', minWidth: 60, ...(flush ? { width: flushWidth + 2, overflow: 'hidden' as const } : null), backgroundColor: mine ? t.bubble : t.incoming, borderRadius: radius, borderBottomRightRadius: mine ? Math.min(6, radius) : radius, borderBottomLeftRadius: mine ? radius : Math.min(6, radius), paddingHorizontal: flush ? 0 : 11, paddingTop: flush ? 0 : file ? 5 : 6, paddingBottom: inlineTime ? 6 : 5, borderWidth: 1, borderColor: p?.state === 'failed' ? t.danger : mine ? (t.black ? 'rgba(255,255,255,0.25)' : t.dark ? 'rgba(157,182,255,0.25)' : 'rgba(255,255,255,0.83)') : (t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.92)') }}>
          {message?.meta?.forward ? <Text style={[{ color: t.accent, fontSize: 11, fontWeight: '600', marginBottom: 4, paddingHorizontal: 1 }, flush ? { paddingHorizontal: 12, paddingTop: 7 } : null]}>Переслано от {message.meta.forward.from}</Text> : null}
          {reply ? <Pressable accessibilityRole="button" accessibilityLabel="Перейти к исходному сообщению" onPress={() => handlers.current.jumpTo(reply.clientId)} style={{ flexDirection: 'row', gap: 7, marginBottom: 6, ...(flush ? { marginHorizontal: 8, marginTop: 8 } : null), paddingVertical: 5, paddingRight: 8, borderRadius: 10, backgroundColor: t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}><View style={{ width: 3, borderRadius: 2, backgroundColor: t.accent }} /><View style={{ flexShrink: 1, gap: 1 }}><Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{replyAuthor}</Text><Text numberOfLines={2} style={{ color: t.muted, fontSize: 12 }}>{replyText}</Text></View></Pressable> : null}
          {row.album ? <View style={{ marginBottom: body ? 7 : 0 }}><AlbumGrid api={api} items={row.album.map(part => part.attachment)} width={albumWidth} onOpen={attachment => selecting ? press() : handlers.current.open(attachment)} onLongPress={() => longPress(0)} /></View> : null}
          {file ? <View style={{ marginBottom: body ? 7 : bare ? 0 : 1, marginTop: bare || flush ? 0 : 1 }}>{isVoice(file) ? <VoiceBubble attachment={file} mine={mine} /> : isVideoNote(file) ? <VideoNoteBubble api={api} attachment={file} /> : visual && box ? <MediaTile api={api} attachment={file} width={box.width} height={box.height} radius={bare ? 18 : flush ? 0 : 14} onOpen={() => selecting ? press() : handlers.current.open(file)} onLongPress={() => longPress(0)} /> : file.encryption ? <FileBubble api={api} attachment={file} onOpen={() => handlers.current.open(file)} /> : <AttachmentCard api={api} attachment={file} onPress={() => handlers.current.open(file)} />}</View> : null}
          {poll ? <PollBubble poll={poll} results={message?.poll} disabled={!message || message.cryptoState !== 'decrypted' || selecting} onVote={options => message && handlers.current.vote(message, options)} /> : null}
          {body ? <Text selectable={false} style={emoji ? { fontSize: emoji === 1 ? 64 : emoji === 2 ? 52 : 44, lineHeight: emoji === 1 ? 76 : emoji === 2 ? 62 : 54 } : { color: t.text, fontSize, lineHeight, paddingHorizontal: flush ? 12 : 1 }}>{body}{inlineTime ? <Text style={{ fontSize: 11, color: 'transparent' }}>{`\u00A0\u00A0\u00A0${message?.edited ? 'изм. ' : ''}${formatTime(row.createdAt)}${mine ? '\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0' : ''}\u00A0`}</Text> : null}</Text> : null}
          {reactionsInside ? <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 6, paddingHorizontal: flush ? 12 : 0 }}><View style={{ flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>{reactionChips(true)}</View><View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4, paddingBottom: 1 }}>{downloading ? <ActivityIndicator color={t.accent} size="small" /> : null}<Text style={{ color: bare && !body ? '#FFF' : t.muted, fontSize: 11 }}>{message?.edited ? 'изм. ' : ''}{formatTime(row.createdAt)}</Text>{p || row.album?.some(part => part.pending) ? (p?.state === 'failed' || row.album?.some(part => part.pending?.state === 'failed')) ? <Icon name="alert-circle" size={13} color={t.danger} /> : <Icon name="time-outline" size={12} color={bare && !body ? '#FFF' : t.muted} /> : mine ? <Icon name={read ? 'checkmark-done' : 'checkmark'} size={15} color={bare && !body ? '#FFF' : read ? t.accent : t.muted} /> : null}</View></View> : <View style={inlineTime ? { position: 'absolute', right: 10, bottom: 5, flexDirection: 'row', alignItems: 'center', gap: 4 } : bare && !body ? { position: 'absolute', right: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: 'rgba(10,15,30,0.5)' } : { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 5, marginTop: 4 }}>{downloading ? <ActivityIndicator color={t.accent} size="small" /> : null}<Text style={{ color: bare && !body ? '#FFF' : t.muted, fontSize: 11 }}>{message?.edited ? 'изм. ' : ''}{formatTime(row.createdAt)}</Text>{p || row.album?.some(part => part.pending) ? (p?.state === 'failed' || row.album?.some(part => part.pending?.state === 'failed')) ? <Icon name="alert-circle" size={13} color={t.danger} /> : <Icon name="time-outline" size={12} color={bare && !body ? '#FFF' : t.muted} /> : mine ? <Icon name={read ? 'checkmark-done' : 'checkmark'} size={15} color={bare && !body ? '#FFF' : read ? t.accent : t.muted} /> : null}</View>}
        </Pressable>
        {message?.reactions.length && !reactionsInside ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4, maxWidth: wide ? '76%' : '85%', justifyContent: mine ? 'flex-end' : 'flex-start' }}>{reactionChips(false)}</View> : null}
        {p?.state === 'failed' ? <Pressable accessibilityRole="button" onPress={() => handlers.current.retry(p)} style={{ paddingVertical: 8, maxWidth: '85%', gap: 3 }}><Text style={{ fontSize: 11, color: t.danger, fontWeight: '600' }}>Не отправлено · повторить</Text>{p.error ? <Text style={{ fontSize: 10, lineHeight: 14, color: t.muted }}>{p.error}</Text> : null}</Pressable> : null}
      </View>
    </SwipeToReply>
    </View>
    </Pressable>
  </Animated.View>;
}

/** Re-renders only when this row's own data changes, not on every keystroke in the composer. */
export const MessageRow = memo(MessageRowView);
