// Music for everyone in a room — on the computer only. One person turns it on; what they play (which track,
// where in it, playing or paused) is told to the others straight over the room's own peer-to-peer channel,
// and every computer plays the track itself from the catalogue. No sound is sent, the server sees nothing.
// Phones take no part: they neither play nor show it.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Icon } from '../components';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { useMusic } from '../music/MusicProvider';
import type { MusicTrack } from '../music/types';
import { onRoomMusic, sendRoomMusic, type VoicePeer } from '../communities/voice';
import type { RoomMember } from './rooms';

export const roomMusicAvailable = Platform.OS === 'web';
/** How far the listener may drift from the host before it jumps to the host's place, seconds. */
const DRIFT = 2.5;
/** How often the host repeats where it is, so a listener that fell behind catches up. */
const BEAT_MS = 4000;

type Wire = { off?: boolean; t?: { id: string; source: MusicTrack['source']; sourceId?: string; title: string; artist: string; duration: number }; pos?: number; playing?: boolean };
const validTrack = (t: Wire['t']): t is NonNullable<Wire['t']> => !!t && typeof t.id === 'string' && t.id.length <= 120 && (t.source === 'audius' || t.source === 'soundcloud')
  && (t.sourceId === undefined || (typeof t.sourceId === 'string' && t.sourceId.length <= 80)) && typeof t.title === 'string' && typeof t.artist === 'string' && Number.isFinite(t.duration);

/** The line under the people of a room: what plays for everyone, or the button that starts it. */
export function RoomMusicLine({ members, peers }: { members: RoomMember[]; peers: VoicePeer[] }) {
  const t = useTheme(); const music = useMusic();
  // 'me' while this computer leads, a peer id while that peer leads, null when nothing is shared.
  const [host, setHost] = useState<string | null>(null); const [track, setTrack] = useState<Wire['t'] | null>(null);
  const live = useRef(music); live.current = music;
  const hostRef = useRef(host); hostRef.current = host;
  const applying = useRef(false);

  const tell = () => {
    const now = live.current, current = now.current;
    if (!current || current.source === 'local') return;
    sendRoomMusic({ t: { id: current.id, source: current.source, sourceId: current.sourceId, title: current.title.slice(0, 70), artist: current.artist.slice(0, 50), duration: Math.round(current.duration) }, pos: Math.round(now.position * 10) / 10, playing: now.playing });
  };

  // Listening: follow whoever leads.
  useEffect(() => onRoomMusic((peer, data: Wire) => {
    if (data.off) { if (hostRef.current === peer) { setHost(null); setTrack(null); if (live.current.playing) void live.current.togglePlayback(); } return; }
    if (!validTrack(data.t) || typeof data.pos !== 'number' || !Number.isFinite(data.pos)) return;
    setHost(peer); setTrack(data.t);
    if (applying.current) return;
    applying.current = true;
    void (async () => {
      try {
        const now = live.current, wanted = data.t!, place = Math.max(0, Math.min(data.pos!, wanted.duration || data.pos!));
        if (now.current?.id !== wanted.id) { await now.play({ ...wanted, artworkUrl: null, downloadable: false }); await live.current.seek(place); }
        else if (Math.abs(now.position - place) > DRIFT) await now.seek(place);
        if (live.current.playing !== !!data.playing && !live.current.loading) await live.current.togglePlayback();
      } catch { /* the track cannot be played here: the line still says what the others hear */ }
      finally { applying.current = false; }
    })();
  }, () => { if (hostRef.current === 'me') tell(); }), []);

  // Leading: tell the others on every change and on a slow beat.
  const leading = host === 'me', currentId = music.current?.id, playing = music.playing;
  useEffect(() => { if (leading) tell(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [leading, currentId, playing]);
  useEffect(() => { if (!leading) return; const timer = setInterval(tell, BEAT_MS); return () => clearInterval(timer); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [leading]);
  // Leaving the room: the lead ends for everyone; what was playing along stops.
  useEffect(() => () => { if (hostRef.current === 'me') sendRoomMusic({ off: true }); else if (hostRef.current && live.current.playing) void live.current.togglePlayback(); }, []);

  const start = () => { setHost('me'); setTrack(null); };
  const stop = () => { sendRoomMusic({ off: true }); setHost(null); };
  const shown = leading ? music.current : track;
  const by = leading ? 'ты' : members.find(member => member.id === peers.find(peer => peer.peer === host)?.userId)?.displayName.split(/\s+/)[0] || 'кто-то';
  const local = music.current?.source === 'local';

  if (host && shown) return <View style={{ alignSelf: 'center', maxWidth: 460, width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
    <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="musical-notes" size={20} color={t.text} /></View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text raw numberOfLines={1} style={{ color: t.text, fontSize: 15.5, fontWeight: '600' }}>{shown.title}</Text>
      <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12.5 }}>{`включил ${by} · играет у всех на компьютере`}</Text>
    </View>
    {leading ? <Pressable accessibilityRole="button" accessibilityLabel="Выключить музыку для всех" onPress={stop} style={{ paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: 1, borderColor: t.glassBorder, justifyContent: 'center' }}><Text style={{ color: t.text, fontSize: 13 }}>Выключить</Text></Pressable> : null}
  </View>;
  return <Pressable accessibilityRole="button" accessibilityLabel="Музыка для всех" disabled={!music.current || local} onPress={start} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: !music.current || local ? 0.55 : pressed ? 0.7 : 1 })}>
    <Icon name="musical-notes-outline" size={17} color={t.muted} />
    <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13.5, maxWidth: 380 }}>{local ? 'Свой файл нельзя включить для всех — выбери трек из каталога' : music.current ? `Включить «${music.current.title.slice(0, 40)}» для всех` : 'Музыка для всех: сначала включи трек во вкладке «Музыка»'}</Text>
  </Pressable>;
}
