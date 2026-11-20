// «Комнаты» in the «Каналы» tab (the first section there), and the host that keeps the list alive and shows
// the «зовёт в комнату» call wherever you are in the app.
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Api } from '../api';
import type { User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { Avatar, Icon } from '../components';
import { GlassSurface } from '../glass';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { impactFeedback } from '../haptics';
import { playCallSound, stopCallSound } from '../calls/callSounds';
import { useVoice } from '../communities/voice';
import { navigate } from '../navigation';
import { RoomFaces } from './RoomScreen';
import { dismissRing, enterRoom, handleRoomEvent, insideLine, loadRooms, openRoom, sleepLine, useRooms, type Room } from './rooms';

const TALK = '#3EE08E';
/** How long a «зовёт в комнату» call rings before it gives up on its own. */
const RING_MS = 30_000;

/** True while somebody is inside any of your rooms (the quiet dot on the «Каналы» tab). */
export function useRoomsAwake(): boolean {
  return !!useRooms().rooms?.some(room => room.inside.length > 0);
}

export function RoomsSection({ api, me, store }: { api: Api; me: User; store: MessengerStore }) {
  const t = useTheme(); const { rooms } = useRooms(); const voice = useVoice();
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const header = <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 6 }}>КОМНАТЫ</Text>;
  if (!rooms) return null;
  if (!rooms.length) return <View>{header}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 20, borderWidth: 1, borderColor: t.border, borderStyle: 'dashed' }}>
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="mic-outline" size={21} color={t.text} /></View>
      <Text style={{ flex: 1, color: t.muted, fontSize: 13.5, lineHeight: 19 }}>Комнат пока нет. В чатах удержи собеседника, нажми «Выбрать», отметь людей и позвони всем сразу — получится комната.</Text>
    </View>
  </View>;
  const enter = async (room: Room) => {
    setBusy(room.id); setError(''); openRoom(room.id);
    try { if (voice?.roomId !== room.id) await enterRoom(api, store, room, me.id); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось зайти.'); } finally { setBusy(''); }
  };
  return <View>{header}
    {error ? <Text style={{ color: t.danger, fontSize: 13, paddingHorizontal: 8, paddingBottom: 6 }}>{error}</Text> : null}
    {rooms.map(room => {
      const inside = new Set(room.inside.map(member => member.userId)), here = voice?.roomId === room.id;
      if (inside.size || here) {
        return <Pressable key={room.id} accessibilityRole="button" accessibilityLabel={`Комната ${room.name}, ${insideLine(inside.size)}`} onPress={() => openRoom(room.id)} style={({ pressed }) => ({ marginBottom: 8, padding: 14, borderRadius: 26, borderWidth: 1, borderColor: 'rgba(62,224,142,0.28)', backgroundColor: t.dark ? 'rgba(62,224,142,0.06)' : 'rgba(62,224,142,0.10)', opacity: pressed ? 0.85 : 1, flexDirection: 'row', alignItems: 'center', gap: 12 })}>
          <RoomFaces api={api} room={room} only={inside.size ? inside : undefined} size={44} ring={TALK} hide={inside.size > 1 ? me.id : undefined} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text raw numberOfLines={1} style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>{room.name}</Text>
            <Text numberOfLines={1} style={{ color: TALK, fontSize: 13, marginTop: 2 }}>{here ? `ты внутри · ${insideLine(Math.max(inside.size, 1))}` : insideLine(inside.size)}</Text>
          </View>
          {here ? null : <Pressable accessibilityRole="button" accessibilityLabel="Зайти" disabled={busy === room.id} onPress={() => { void enter(room); }} style={({ pressed }) => ({ paddingHorizontal: 16, height: 40, borderRadius: 20, backgroundColor: t.text, alignItems: 'center', justifyContent: 'center', opacity: pressed || busy === room.id ? 0.7 : 1 })}><Text style={{ color: t.bg, fontSize: 14, fontWeight: '600' }}>Зайти</Text></Pressable>}
        </Pressable>;
      }
      return <Pressable key={room.id} accessibilityRole="button" accessibilityLabel={`Комната ${room.name}, спит`} onPress={() => openRoom(room.id)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, borderRadius: 16, backgroundColor: pressed ? t.accentSoft : 'transparent', opacity: room.awake ? 0.85 : 0.55 })}>
        <RoomFaces api={api} room={room} size={42} hide={me.id} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text raw numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{room.name}</Text>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13.5 }}>{room.awake ? 'никого · ещё не спит' : sleepLine(room)}</Text>
        </View>
        <Text style={{ color: t.subtle, fontSize: 12 }}>{`${room.members.length} чел`}</Text>
      </Pressable>;
    })}
  </View>;
}

/**
 * Mounted once for the signed-in account: loads the rooms, follows their socket events and shows the
 * incoming «зовёт в комнату» call over any screen until it is answered, dismissed or times out.
 */
export function RoomsHost({ api, me, store }: { api: Api; me: User; store: MessengerStore }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const { ring, rooms } = useRooms();
  useEffect(() => { void loadRooms(api, me.id); }, [api, me.id]);
  useEffect(() => store.onSocket(data => { if (data?.type === 'ready') void loadRooms(api, me.id); else handleRoomEvent(data, me.id); }), [store, api, me.id]);
  useEffect(() => {
    if (!ring) return;
    impactFeedback(); void playCallSound('incoming');
    const timer = setTimeout(dismissRing, RING_MS);
    return () => { clearTimeout(timer); stopCallSound(); };
  }, [ring]);
  if (!ring) return null;
  const room = rooms?.find(item => item.id === ring.roomId);
  const answer = () => {
    openRoom(ring.roomId); navigate({ to: 'channels' });
    if (room) void enterRoom(api, store, room, me.id).catch(() => { /* the room screen shows «Зайти» and the reason */ });
    else dismissRing();
  };
  return <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: insets.top + 8, alignItems: 'center', zIndex: 50 }}>
    <GlassSurface lens material="regular" radius={26} style={{ marginHorizontal: 12, maxWidth: 460, alignSelf: 'center', width: '94%' }} contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10 }}>
      <Avatar api={api} user={ring.from as unknown as User} size={46} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text raw numberOfLines={1} style={{ color: t.text, fontSize: 15.5, fontWeight: '700' }}>{ring.from.displayName}</Text>
        <Text numberOfLines={1} style={{ color: TALK, fontSize: 13 }}>{`зовёт в комнату${room ? ` · ${insideLine(room.inside.length)}` : ''}`}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Не сейчас" onPress={dismissRing} style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.glassBorder }}><Icon name="close" size={20} color={t.text} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Зайти в комнату" onPress={answer} style={{ paddingHorizontal: 16, height: 42, borderRadius: 21, backgroundColor: TALK, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#04210F', fontSize: 14, fontWeight: '700' }}>Зайти</Text></Pressable>
    </GlassSurface>
  </View>;
}
