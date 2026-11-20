// A room on screen: you in the middle, the others scattered around you, each with their own light behind
// them. Whoever is talking gets a green ring; members who are not inside right now are shown small and dim
// in their usual place. Below: «Позвать всех» (rings like a call) and the microphone, sound and leave buttons.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Api } from '../api';
import type { User } from '../types';
import type { MessengerStore } from '../useMessenger';
import { Avatar, Button, Field, Icon, IconButton, Notice, Sheet, SheetAction } from '../components';
import { GlassSurface } from '../glass';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { useTabInset } from '../tabInset';
import { brightTint, peerTint } from '../design/peerLight';
import { toggleVoiceMute, toggleVoiceSpeaker, useVoice, voiceSpeaking } from '../communities/voice';
import { enterRoom, exitRoom, insideLine, seatSize, seats, sleepLine, useRooms, type Room, type RoomMember } from './rooms';

const TALK = '#3EE08E';
const asUser = (member: RoomMember) => member as unknown as User;
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(item => b.has(item));

export function RoomScreen({ api, me, store, roomId, onBack }: { api: Api; me: User; store: MessengerStore; roomId: string; onBack: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const tabInset = useTabInset();
  const room = useRooms().rooms?.find(item => item.id === roomId);
  const voice = useVoice(); const here = !!voice && voice.roomId === roomId;
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [menu, setMenu] = useState(false);
  const [rename, setRename] = useState<string | null>(null); const [rang, setRang] = useState(0);

  // Who is talking: asked from the connections a few times a second, only while you are inside.
  useEffect(() => {
    if (!here) { setSpeaking(current => current.size ? new Set() : current); return; }
    let alive = true;
    const timer = setInterval(() => {
      void voiceSpeaking().then(peers => {
        if (!alive) return;
        const users = new Set<string>();
        peers.forEach(peer => { if (peer === 'me') users.add(me.id); else { const found = voice?.peers.find(item => item.peer === peer); if (found) users.add(found.userId); } });
        setSpeaking(current => sameSet(current, users) ? current : users);
      });
    }, 350);
    return () => { alive = false; clearInterval(timer); };
  }, [here, me.id, voice?.peers]);

  const places = useMemo(() => room ? seats(room, me.id) : new Map<string, { x: number; y: number }>(), [room, me.id]);
  if (!room) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 }}><Text style={{ color: t.muted, fontSize: 15, textAlign: 'center' }}>Этой комнаты больше нет.</Text><Button label="Назад" secondary onPress={onBack} /></View>;

  // While inside, the engine's own list is the freshest; outside, the server's.
  const inside = new Set<string>(here ? [me.id, ...(voice?.peers || []).map(peer => peer.userId)] : room.inside.map(member => member.userId));
  const muted = new Set<string>([...room.inside.filter(member => member.muted).map(member => member.userId), ...(here ? (voice?.peers || []).filter(peer => peer.muted).map(peer => peer.userId) : [])]);
  if (here) { if (voice?.muted) muted.add(me.id); else muted.delete(me.id); }
  // On a wide screen the people stay together in the middle instead of drifting to the edges.
  const span = Math.min(stage.w, 620), left = (stage.w - span) / 2;
  const size = seatSize(room.members.length, span || 360), pad = size * 0.62;
  const at = (id: string) => { const place = places.get(id) || { x: 0.5, y: 0.5 }; return { x: left + pad + place.x * Math.max(0, span - pad * 2), y: pad * 0.9 + place.y * Math.max(0, stage.h - pad * 2.1) }; };
  const status = here ? (voice?.status === 'connected' ? `комната · ${insideLine(inside.size)}` : 'подключение…') : room.inside.length ? `комната · ${insideLine(room.inside.length)}` : room.awake ? 'комната · никого, ещё не спит' : sleepLine(room);
  const lit = room.members.filter(member => inside.has(member.id));

  const enter = async () => { setBusy(true); setError(''); try { await enterRoom(api, store, room, me.id); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось зайти.'); } finally { setBusy(false); } };
  const ring = async () => { setError(''); try { const result = await api.ringRoom(room.id); setRang(result.rang || 0); setTimeout(() => setRang(0), 4000); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось позвать.'); } };
  const saveName = async () => { if (rename === null) return; try { await api.renameRoom(room.id, rename.trim()); setRename(null); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось переименовать.'); setRename(null); } };
  const leaveForGood = async () => { setMenu(false); try { if (here) exitRoom(); await api.leaveRoom(room.id); onBack(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось выйти.'); } };

  return <View style={{ flex: 1 }}>
    <GlassSurface lens material="clear" radius={27} style={{ marginHorizontal: 14, marginTop: 12 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 6, minHeight: 64 }}>
      <IconButton name="chevron-back" label="Назад" onPress={onBack} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text raw numberOfLines={1} style={{ fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: t.text }}>{room.name}</Text>
        <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '600', color: inside.size ? TALK : t.muted }}>{status}</Text>
      </View>
      <IconButton name="ellipsis-horizontal" label="Действия с комнатой" onPress={() => setMenu(true)} />
    </GlassSurface>

    <View style={{ flex: 1 }} onLayout={event => { const { width, height } = event.nativeEvent.layout; if (Math.abs(width - stage.w) > 1 || Math.abs(height - stage.h) > 1) setStage({ w: width, h: height }); }}>
      {stage.w > 0 ? <>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Svg width={stage.w} height={stage.h}>
            <Defs>{lit.map(member => { const p = at(member.id); const color = brightTint(peerTint(member.avatarColor, '#8A8F98'), 150); return <RadialGradient key={member.id} id={`light-${member.id}`} cx={p.x} cy={p.y} r={size * 2.3} gradientUnits="userSpaceOnUse"><Stop offset="0" stopColor={color} stopOpacity={speaking.has(member.id) ? 0.42 : 0.26} /><Stop offset="1" stopColor={color} stopOpacity={0} /></RadialGradient>; })}</Defs>
            {lit.map(member => <Rect key={member.id} x={0} y={0} width={stage.w} height={stage.h} fill={`url(#light-${member.id})`} />)}
          </Svg>
        </View>
        {room.members.map(member => {
          const p = at(member.id), mine = member.id === me.id, present = inside.has(member.id), talking = present && speaking.has(member.id);
          const side = Math.round((mine ? size * 0.82 : size) * (present || mine ? 1 : 0.72)), box = side + 56;
          return <View key={member.id} accessible accessibilityLabel={`${mine ? 'Ты' : member.displayName}${present ? talking ? ', говорит' : muted.has(member.id) ? ', микрофон выключен' : ', в комнате' : ', не в комнате'}`} style={{ position: 'absolute', left: p.x - box / 2, top: p.y - side / 2 - 5, width: box, alignItems: 'center', opacity: present ? 1 : mine ? 0.7 : 0.3 }}>
            <View style={{ padding: 3, borderRadius: side, borderWidth: talking ? 3 : 1.5, borderColor: talking ? TALK : mine && present ? t.text : 'transparent', margin: talking ? 0 : 1.5 }}>
              <Avatar api={api} user={asUser(member)} size={side} />
              {present && muted.has(member.id) ? <View style={{ position: 'absolute', right: -2, bottom: -2, width: 26, height: 26, borderRadius: 13, backgroundColor: t.glassOpaque, borderWidth: 2, borderColor: t.bg, alignItems: 'center', justifyContent: 'center' }}><Icon name="mic-off" size={13} color={t.text} /></View> : null}
            </View>
            <Text raw={!mine} numberOfLines={1} style={{ marginTop: 6, fontSize: 13, fontWeight: '500', color: present ? t.text : t.muted }}>{mine ? 'ты' : member.displayName.split(/\s+/)[0]}</Text>
          </View>;
        })}
      </> : null}
    </View>

    <View style={{ paddingHorizontal: 18, paddingBottom: 18 + insets.bottom + tabInset, gap: 14, alignItems: 'center' }}>
      {error ? <View style={{ alignSelf: 'stretch' }}><Notice text={error} error /></View> : null}
      {voice?.error && here ? <View style={{ alignSelf: 'stretch' }}><Notice text={voice.error} error /></View> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Позвать всех" onPress={ring} style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: t.glassBorder, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: '500' }}>{rang ? `Позвали: ${rang}` : 'Позвать всех'}</Text>
      </Pressable>
      {here ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <Round label={voice?.speaker ? 'Звук на динамике' : 'Звук в трубке'} icon={voice?.speaker ? 'volume-high' : 'ear-outline'} onPress={toggleVoiceSpeaker} />
        <Pressable accessibilityRole="button" accessibilityLabel={voice?.muted ? 'Включить микрофон' : 'Выключить микрофон'} onPress={toggleVoiceMute} style={({ pressed }) => ({ width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center', backgroundColor: voice?.muted ? t.glassOpaque : t.text, borderWidth: voice?.muted ? 1 : 0, borderColor: t.glassBorder, opacity: pressed ? 0.8 : 1 })}>
          <Icon name={voice?.muted ? 'mic-off' : 'mic'} size={28} color={voice?.muted ? t.text : t.bg} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Выйти из комнаты" onPress={exitRoom} style={({ pressed }) => ({ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FF4D5E', opacity: pressed ? 0.8 : 1 })}>
          <Icon name="close" size={26} color="#FFF" />
        </Pressable>
      </View> : <View style={{ alignSelf: 'center', maxWidth: 420, width: '100%' }}><Button label="Зайти" icon="mic" loading={busy} onPress={enter} /></View>}
    </View>

    <Sheet visible={menu} title={room.name} onClose={() => setMenu(false)}>
      <SheetAction icon="create-outline" label="Переименовать" onPress={() => { setMenu(false); setRename(room.auto ? '' : room.name); }} />
      <SheetAction icon="exit-outline" label="Уйти из комнаты насовсем" description="Она пропадёт из твоего списка. Остальные останутся." danger onPress={leaveForGood} />
    </Sheet>
    <Sheet visible={rename !== null} title="Название комнаты" onClose={() => setRename(null)}>
      <View style={{ gap: 12 }}>
        <Field value={rename || ''} onChangeText={setRename} placeholder="Например, Свои" maxLength={48} autoFocus />
        <Text style={{ color: t.muted, fontSize: 13 }}>Пустое поле вернёт название из имён участников.</Text>
        <Button label="Сохранить" onPress={saveName} />
      </View>
    </Sheet>
  </View>;
}

function Round({ icon, label, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; onPress: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.glassBorder, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
    <Icon name={icon} size={24} color={t.text} />
  </Pressable>;
}

/** The members of a room as overlapping avatars (the list card and the call banner). */
export function RoomFaces({ api, room, only, size = 40, ring, hide }: { api: Api; room: Room; only?: Set<string>; size?: number; ring?: string; /** Your own id: you are not drawn among the faces of your own room. */ hide?: string }) {
  const t = useTheme();
  const shown = room.members.filter(member => member.id !== hide && (!only || only.has(member.id))).slice(0, 3);
  return <View style={{ flexDirection: 'row' }}>{shown.map((member, index) => <View key={member.id} style={{ marginLeft: index ? -size * 0.28 : 0, borderRadius: size, borderWidth: 2.5, borderColor: index === 0 && ring ? ring : t.bg }}><Avatar api={api} user={asUser(member)} size={size} /></View>)}</View>;
}
