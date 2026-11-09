// Люди › Звонки (F9): recent calls grouped by day, as in Telegram's Calls tab. Built from the local
// decrypted cache only (useCallHistory in CallProvider), never from the server.
import React, { useMemo } from 'react';
import { Pressable, SectionList, View } from 'react-native';
import { Text } from '../typography';
import { Avatar, Empty, Icon, type IconName } from '../components';
import { formatTime, useTheme } from '../theme';
import type { Api } from '../api';
import type { Chat } from '../types';
import { useCallHistory, useCalls } from './CallProvider';
import { callAnswered, callLabel, groupCallsByDay, type CallHistoryRow, type CallKind } from './callLog';
import { formatCallDuration } from './callModel';

const kindIcon = (kind: CallKind): IconName => kind === 'outgoing' || kind === 'cancelled' || kind === 'busy' ? 'arrow-up-outline' : kind === 'incoming' || kind === 'missed' ? 'arrow-down-outline' : kind === 'declined' ? 'ban-outline' : 'alert-circle-outline';
/** Telegram paints a missed or declined call red; the rest stays calm. */
const isRed = (kind: CallKind) => kind === 'missed' || kind === 'declined';

export function CallHistory({ api, onOpen, bottomInset = 0 }: { api: Api; onOpen: (chat: Chat) => void; bottomInset?: number }) {
  const t = useTheme(); const records = useCallHistory(); const calls = useCalls();
  const sections = useMemo(() => groupCallsByDay(records).map(group => ({ key: group.day, title: group.label, data: group.calls })), [records]);
  if (!records.length) return <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 35 + bottomInset }}><Empty icon="call-outline" title="Звонков пока не было" description="Здесь появятся входящие, исходящие и пропущенные звонки. Позвонить можно из чата или из профиля человека." /></View>;
  return <SectionList sections={sections} keyExtractor={item => item.key} stickySectionHeadersEnabled={false} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 24 + bottomInset }}
    renderSectionHeader={({ section }) => <Text style={{ fontSize: 10, fontWeight: '700', letterSpacing: 1.7, color: t.muted, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, textTransform: 'uppercase' }}>{section.title}</Text>}
    renderItem={({ item }) => <CallHistoryItem item={item} api={api} onOpen={() => onOpen(item.chat)} onCall={calls.available ? () => calls.start(item.chat, item.video) : undefined} busy={calls.busy} />} />;
}

function CallHistoryItem({ item, api, onOpen, onCall, busy }: { item: CallHistoryRow; api: Api; onOpen: () => void; onCall?: () => void; busy: boolean }) {
  const t = useTheme();
  const red = isRed(item.kind);
  const label = `${callLabel(item.kind, item.video)}${callAnswered(item.kind) && item.duration !== undefined ? ` · ${formatCallDuration(item.duration)}` : ''}`;
  const name = `${item.chat.peer.displayName}${item.count > 1 ? ` (${item.count})` : ''}`;
  return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${name}: ${label}, ${formatTime(item.at)}`} accessibilityHint="Открыть чат"
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, marginBottom: 6, borderRadius: 24, borderWidth: 1, borderColor: pressed ? t.border : 'transparent', backgroundColor: pressed ? (t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.5)') : 'transparent' })}>
    <Avatar user={item.chat.peer} api={api} size={50} />
    <View style={{ flex: 1, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text raw numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, fontWeight: '600', letterSpacing: -.2, color: item.kind === 'missed' ? t.danger : t.text }}>{name}</Text>
        {item.unseen ? <View accessibilityLabel="Пропущенный, непрочитанный" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.danger }} /> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Icon name={kindIcon(item.kind)} size={14} color={red ? t.danger : t.muted} />
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: red ? t.danger : t.muted }}>{label}</Text>
      </View>
    </View>
    <Text style={{ fontSize: 13, color: t.muted, fontVariant: ['tabular-nums'] }}>{formatTime(item.at)}</Text>
    <Pressable disabled={!onCall || busy} onPress={onCall} accessibilityRole="button" accessibilityLabel={`Перезвонить: ${item.chat.peer.displayName}`} hitSlop={6}
      style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.border, backgroundColor: t.accentSoft, opacity: !onCall || busy ? .4 : pressed ? .6 : 1 })}>
      <Icon name={item.video ? 'videocam-outline' : 'call-outline'} size={19} color={t.accent} />
    </Pressable>
  </Pressable>;
}
