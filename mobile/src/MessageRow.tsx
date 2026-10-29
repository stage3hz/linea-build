import React, { memo, useRef } from 'react';
import { ActivityIndicator, Animated, PanResponder, Pressable, View } from 'react-native';
import { Text } from './typography';
import { AttachmentCard, Icon } from './components';
import { formatDay, formatTime, useTheme } from './theme';
import type { Api } from './api';
import type { Attachment, PendingMessage } from './types';
import type { Reaction, ViewMessage } from './messageMeta';
import { VoiceBubble } from './voice/VoiceMessage';
import { isVideoNote, isVoice } from './voice/voice';
import { VideoNoteBubble } from './videonote/VideoNote';

export type Row = { key: string; message?: ViewMessage; pending?: PendingMessage; createdAt: string };
export type RowHandlers = {
  actions: (row: Row, y: number) => void; jumpTo: (clientId: string) => void; open: (file: Attachment) => void;
  react: (message: ViewMessage, emoji: Reaction) => void; retry: (pending: PendingMessage) => void; reply: (message: ViewMessage) => void;
};
type Props = {
  row: Row; olderCreatedAt?: string; mine: boolean; author: string; peerLastRead: number; wide: boolean;
  fontSize: number; lineHeight: number; downloading: boolean; replyAuthor?: string; replyText?: string;
  api: Api; handlers: React.MutableRefObject<RowHandlers>;
};

/** Swipe a message to the LEFT to reply, as in Telegram for iPhone (a right swipe goes back). */
function SwipeToReply({ enabled, onReply, children }: { enabled: boolean; onReply: () => void; children: React.ReactNode }) {
  const t = useTheme();
  const x = useRef(new Animated.Value(0)).current;
  const fired = useRef(false); const reply = useRef(onReply); reply.current = onReply;
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dx < -12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderGrant: () => { fired.current = false; },
    onPanResponderMove: (_e, g) => { const value = Math.min(0, Math.max(-90, g.dx)); x.setValue(value); if (value <= -64 && !fired.current) fired.current = true; },
    onPanResponderRelease: () => { if (fired.current) reply.current(); Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start(); },
    onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
    onPanResponderTerminationRequest: () => false,
  })).current;
  if (!enabled) return <>{children}</>;
  const iconOpacity = x.interpolate({ inputRange: [-64, -10], outputRange: [1, 0], extrapolate: 'clamp' });
  return <View>
    <Animated.View pointerEvents="none" style={{ position: 'absolute', right: 4, top: 0, bottom: 8, justifyContent: 'center', opacity: iconOpacity }}>
      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-undo" size={17} color={t.accent} /></View>
    </Animated.View>
    <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: x }] }}>{children}</Animated.View>
  </View>;
}

function MessageRowView({ row, olderCreatedAt, mine, author, peerLastRead, wide, fontSize, lineHeight, downloading, replyAuthor, replyText, api, handlers }: Props) {
  const t = useTheme();
  const message = row.message; const p = row.pending;
  const body = message?.text || p?.text || ''; const file = message?.attachment || p?.attachment;
  const showDay = !olderCreatedAt || new Date(olderCreatedAt).toDateString() !== new Date(row.createdAt).toDateString();
  const reply = message?.meta?.reply || p?.meta?.reply;
  const circle = !!file && isVideoNote(file) && !body;
  const read = peerLastRead >= (message?.id || 0);
  const lastTap = useRef(0);
  return <View>
    {showDay ? <View style={{ alignSelf: 'center', backgroundColor: t.black ? 'rgba(0,0,0,0.68)' : t.dark ? 'rgba(30,36,53,0.68)' : 'rgba(255,255,255,0.52)', borderWidth: 1, borderColor: t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.88)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, marginTop: 15, marginBottom: 18 }}><Text style={{ color: t.muted, fontSize: 10, fontWeight: '600' }}>{formatDay(row.createdAt)}</Text></View> : null}
    <SwipeToReply enabled={!!message && message.cryptoState === 'decrypted'} onReply={() => message && handlers.current.reply(message)}>
      <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
        <Pressable onPress={() => { const now = Date.now(); if (message && message.cryptoState === 'decrypted' && now - lastTap.current < 300) { lastTap.current = 0; handlers.current.react(message, '❤️'); } else lastTap.current = now; }} onLongPress={event => handlers.current.actions(row, event.nativeEvent.pageY)} delayLongPress={450} accessibilityLabel={`${author}: ${body || file?.name || 'Вложение'}`} style={circle ? { maxWidth: '85%' } : { maxWidth: wide ? '76%' : '85%', minWidth: 74, backgroundColor: mine ? t.bubble : t.incoming, borderRadius: 23, borderBottomRightRadius: mine ? 8 : 23, borderBottomLeftRadius: mine ? 23 : 8, paddingHorizontal: 12, paddingTop: file ? 7 : 11, paddingBottom: 7, borderWidth: 1, borderColor: p?.state === 'failed' ? t.danger : mine ? (t.black ? 'rgba(255,255,255,0.25)' : t.dark ? 'rgba(157,182,255,0.25)' : 'rgba(255,255,255,0.83)') : (t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.92)') }}>
          {message?.meta?.forward ? <Text style={{ color: t.accent, fontSize: 11, fontWeight: '600', marginBottom: 4, paddingHorizontal: 1 }}>Переслано от {message.meta.forward.from}</Text> : null}
          {reply ? <Pressable accessibilityRole="button" accessibilityLabel="Перейти к исходному сообщению" onPress={() => handlers.current.jumpTo(reply.clientId)} style={{ flexDirection: 'row', gap: 7, marginBottom: 6, paddingVertical: 5, paddingRight: 8, borderRadius: 10, backgroundColor: t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}><View style={{ width: 3, borderRadius: 2, backgroundColor: t.accent }} /><View style={{ flexShrink: 1, gap: 1 }}><Text style={{ color: t.accent, fontSize: 11, fontWeight: '700' }}>{replyAuthor}</Text><Text numberOfLines={2} style={{ color: t.muted, fontSize: 12 }}>{replyText}</Text></View></Pressable> : null}
          {file ? <View style={{ marginBottom: body ? 7 : 1, marginTop: 1 }}>{isVoice(file) ? <VoiceBubble attachment={file} mine={mine} /> : isVideoNote(file) ? <VideoNoteBubble api={api} attachment={file} /> : <AttachmentCard api={api} attachment={file} onPress={() => handlers.current.open(file)} />}</View> : null}
          {body ? <Text selectable style={{ color: t.text, fontSize, lineHeight, paddingHorizontal: 1 }}>{body}</Text> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 5, marginTop: 4 }}>{downloading ? <ActivityIndicator color={t.accent} size="small" /> : null}<Text style={{ color: t.muted, fontSize: 9 }}>{message?.edited ? 'изм. ' : ''}{formatTime(row.createdAt)}</Text>{p ? p.state === 'sending' ? <Icon name="time-outline" size={12} color={t.muted} /> : <Icon name="alert-circle" size={13} color={t.danger} /> : mine ? <Icon name={read ? 'checkmark-done' : 'checkmark'} size={15} color={read ? t.accent : t.muted} /> : null}</View>
        </Pressable>
        {message?.reactions.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4, maxWidth: wide ? '76%' : '85%', justifyContent: mine ? 'flex-end' : 'flex-start' }}>{message.reactions.map(reaction => <Pressable key={reaction.emoji} accessibilityRole="button" accessibilityLabel={`Реакция ${reaction.emoji}: ${reaction.count}${reaction.mine ? ', твоя' : ''}`} onPress={() => handlers.current.react(message, reaction.emoji)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 14, backgroundColor: reaction.mine ? t.accentSoft : t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: reaction.mine ? t.accent : t.border }}><Text style={{ fontSize: 14 }}>{reaction.emoji}</Text>{reaction.count > 1 ? <Text style={{ color: t.text, fontSize: 11, fontWeight: '600' }}>{reaction.count}</Text> : null}</Pressable>)}</View> : null}
        {p?.state === 'failed' ? <Pressable accessibilityRole="button" onPress={() => handlers.current.retry(p)} style={{ paddingVertical: 8, maxWidth: '85%', gap: 3 }}><Text style={{ fontSize: 11, color: t.danger, fontWeight: '600' }}>Не отправлено · повторить</Text>{p.error ? <Text style={{ fontSize: 10, lineHeight: 14, color: t.muted }}>{p.error}</Text> : null}</Pressable> : null}
      </View>
    </SwipeToReply>
  </View>;
}

/** Re-renders only when this row's own data changes, not on every keystroke in the composer. */
export const MessageRow = memo(MessageRowView);
