// «Комнаты»: a lasting voice room for a fixed set of «свои», outside communities. A group call made from the
// chat list becomes one; later the same people just walk in. The sound runs through the same engine as a
// community voice channel (communities/voice.ts): peer to peer, the server only introduces the devices.
// This file keeps the list of the account's rooms (loaded once, then kept current by socket events), which
// room is open on screen, and the «зовёт в комнату» call that is ringing right now.
import { useSyncExternalStore } from 'react';
import type { Api } from '../api';
import type { MessengerStore } from '../useMessenger';
import type { VoiceMember } from '../communities/types';
import { joinVoice, leaveVoice } from '../communities/voice';
import { navigate } from '../navigation';

export const ROOM_LIMIT = 12;
export type RoomMember = { id: string; username: string; displayName: string; avatarColor: string; avatarId: string | null };
export type Room = {
  id: string; name: string;
  /** The name was made from the members' names (nobody renamed the room). */
  auto: boolean; members: RoomMember[]; inside: VoiceMember[];
  /** Somebody is inside, or the last one left less than five minutes ago. */
  awake: boolean; lastActiveAt: string | null; createdAt: string;
};
export type RoomRing = { roomId: string; name: string; from: RoomMember; at: number };
type State = { owner: string; rooms: Room[] | null; openId: string | null; ring: RoomRing | null; error: string };

let state: State = { owner: '', rooms: null, openId: null, ring: null, error: '' };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useRooms = () => useSyncExternalStore(subscribe, () => state, () => state);
export const roomsNow = () => state;

/** Awake rooms first (the busiest on top), then the sleeping ones by when they were last used. */
export function sortRooms(rooms: Room[]): Room[] {
  const used = (room: Room) => Date.parse(room.lastActiveAt || room.createdAt) || 0;
  return [...rooms].sort((a, b) => Number(b.inside.length > 0) - Number(a.inside.length > 0) || Number(b.awake) - Number(a.awake) || b.inside.length - a.inside.length || used(b) - used(a));
}

const upsert = (room: Room) => set({ rooms: sortRooms(state.rooms?.some(item => item.id === room.id) ? state.rooms.map(item => item.id === room.id ? room : item) : [room, ...(state.rooms || [])]) });

export async function loadRooms(api: Api, owner: string) {
  if (state.owner !== owner) state = { owner, rooms: null, openId: null, ring: null, error: '' };
  try { const { rooms } = await api.rooms(); if (state.owner === owner) set({ rooms: sortRooms(rooms), error: '' }); }
  catch (failure) { if (state.owner === owner) set({ error: failure instanceof Error ? failure.message : 'Не удалось загрузить комнаты.' }); }
}

/** Socket events of the rooms. Returns true when the event was one of them. */
export function handleRoomEvent(data: any, me: string): boolean {
  if (!data || typeof data.type !== 'string' || !data.type.startsWith('room.')) return false;
  if ((data.type === 'room.created' || data.type === 'room.updated') && data.room?.id) upsert(data.room as Room);
  else if (data.type === 'room.removed' && typeof data.roomId === 'string') set({ rooms: state.rooms?.filter(room => room.id !== data.roomId) || null, ...(state.openId === data.roomId ? { openId: null } : null), ...(state.ring?.roomId === data.roomId ? { ring: null } : null) });
  else if (data.type === 'room.state' && typeof data.roomId === 'string') {
    const inside: VoiceMember[] = Array.isArray(data.inside) ? data.inside : [];
    set({
      rooms: state.rooms ? sortRooms(state.rooms.map(room => room.id === data.roomId ? { ...room, inside, awake: !!data.awake, lastActiveAt: data.lastActiveAt ?? room.lastActiveAt } : room)) : state.rooms,
      // The call stops ringing once you are inside, or once the room is empty again.
      ...(state.ring?.roomId === data.roomId && (!inside.length || inside.some(member => member.userId === me)) ? { ring: null } : null),
    });
  } else if (data.type === 'room.ring' && typeof data.roomId === 'string' && typeof data.fromId === 'string' && data.fromId !== me) {
    // The server names the caller by id and name; the avatar comes from the room's own member list.
    const known = state.rooms?.find(room => room.id === data.roomId)?.members.find(member => member.id === data.fromId);
    const from: RoomMember = known || { id: data.fromId, username: '', displayName: typeof data.fromName === 'string' ? data.fromName : 'Кто-то из своих', avatarColor: '#8A8F98', avatarId: null };
    set({ ring: { roomId: data.roomId, name: typeof data.name === 'string' ? data.name : '', from, at: Date.now() } });
  }
  return true;
}

export const openRoom = (id: string | null) => set({ openId: id });
export const dismissRing = () => set({ ring: null });

/** Walks into the room: the microphone opens and the others hear you. */
export async function enterRoom(api: Api, store: MessengerStore, room: Room, me: string) {
  set({ ...(state.ring?.roomId === room.id ? { ring: null } : null) });
  await joinVoice(api, store, { communityId: '', communityName: 'Комната', channelId: room.id, channelName: room.name, roomId: room.id, userId: me });
}
export const exitRoom = () => leaveVoice();

/**
 * A group call from the chat list: the room of exactly these people is found or made, opened on screen,
 * entered, and everyone else is called. One person is an ordinary call and never reaches this.
 */
export async function startRoomCall(api: Api, store: MessengerStore, me: string, memberIds: string[]): Promise<Room> {
  const ids = [...new Set(memberIds.filter(id => id && id !== me))];
  if (ids.length < 2) throw new Error('Выбери хотя бы двоих: одному звонят обычным звонком.');
  if (ids.length > ROOM_LIMIT - 1) throw new Error(`В комнате максимум ${ROOM_LIMIT} человек.`);
  const { room } = await api.createRoom(ids);
  upsert(room); set({ openId: room.id }); navigate({ to: 'channels' });
  await enterRoom(api, store, room, me);
  try { await api.ringRoom(room.id); } catch { /* the others still see the room awake and can walk in */ }
  return room;
}

// ---- Seats ----
const hash = (text: string) => { let value = 2166136261; for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 16777619); } return value >>> 0; };

/**
 * Where everyone sits: you in the middle, the others scattered around on an ellipse. A seat depends only on
 * who the members are (their ids), so a person is always found in the same place and nobody jumps when
 * someone walks in or out. Coordinates are fractions of the stage (0…1, the centre of the avatar).
 */
export function seats(room: Pick<Room, 'id' | 'members'>, me: string): Map<string, { x: number; y: number }> {
  const others = room.members.filter(member => member.id !== me).sort((a, b) => hash(room.id + a.id) - hash(room.id + b.id));
  const out = new Map<string, { x: number; y: number }>([[me, { x: 0.5, y: 0.5 }]]);
  const count = others.length, start = -140 + (hash(room.id) % 40);
  others.forEach((member, index) => {
    const wobble = hash(member.id + room.id);
    const angle = (start + index * (360 / Math.max(count, 1)) + (count > 2 ? (wobble % 21) - 10 : 0)) * Math.PI / 180;
    const reach = count > 6 ? 0.92 + ((wobble >> 5) % 9) / 100 : 0.84 + ((wobble >> 5) % 15) / 100;
    out.set(member.id, { x: 0.5 + Math.cos(angle) * 0.36 * reach, y: 0.5 + Math.sin(angle) * 0.38 * reach });
  });
  return out;
}
/** The avatar size for a room of this many people on a stage this wide. */
export const seatSize = (members: number, stage: number) => Math.round(Math.min(members <= 5 ? 88 : members <= 8 ? 70 : 58, stage * (members <= 5 ? 0.24 : members <= 8 ? 0.19 : 0.16)));

/** «спит · были вчера в 18:20». */
export function sleepLine(room: Room, now = Date.now()): string {
  if (!room.lastActiveAt) return 'спит · ещё никто не заходил';
  const at = new Date(room.lastActiveAt), time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  return `спит · были ${days <= 0 ? `сегодня в ${time}` : days === 1 ? `вчера в ${time}` : at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
}
/** «трое внутри» for 3, «5 внутри» above four. */
export function insideLine(count: number): string {
  return `${['никого', 'один', 'двое', 'трое', 'четверо'][count] ?? count} внутри`;
}
