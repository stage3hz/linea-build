import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { Notice } from '../components';
import { ScreenVideo } from './ScreenVideo';
import { startVoiceScreen, stopVoiceScreen, useVoice } from './voice';
import type { ScreenQuality } from './screenShareModel';
export function ScreenSharePanel({ people = {} }: { people?: Record<string,{displayName:string}> }) {
  const voice = useVoice(); const t = useTheme(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  if (!voice) return null;
  const start = async (quality: ScreenQuality) => { setError(''); setBusy(true); try { await startVoiceScreen(quality); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось включить демонстрацию.'); } finally { setBusy(false); } };
  return <View style={{ gap: 10 }}>
    <Text style={{ color: t.text, fontWeight: '700' }}>Демонстрация экрана</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {voice.sharing ? <Pressable accessibilityRole="button" onPress={stopVoiceScreen} style={{ padding: 12, borderRadius: 12, backgroundColor: t.danger }}><Text style={{ color: '#FFF' }}>Остановить демонстрацию</Text></Pressable> : (['720p60', '1080p60'] as const).map(quality => <Pressable key={quality} accessibilityRole="button" disabled={busy || voice.status !== 'connected'} onPress={() => void start(quality)} style={{ padding: 12, borderRadius: 12, backgroundColor: t.accentSoft, opacity: busy ? .5 : 1 }}><Text style={{ color: t.accent }}>{quality === '720p60' ? '720p · 60 FPS' : '1080p · 60 FPS'}</Text></Pressable>)}
    </View>
    <Text style={{ color: t.muted, fontSize: 12 }}>Фактическое качество зависит от устройства и сети. Всё, что видно на экране, может попасть в трансляцию.</Text>
    {busy ? <Pressable accessibilityRole="button" onPress={() => { stopVoiceScreen(); setBusy(false); }}><Text style={{ color: t.accent }}>Отменить запуск</Text></Pressable> : null}
    {error || voice.error ? <Notice error text={error || voice.error} /> : null}
    {voice.sharing && voice.screenStream ? <View><Text style={{ color: t.muted }}>Твой экран</Text><ScreenVideo stream={voice.screenStream} /></View> : null}
    {voice.peers.filter(p => p.screen).map(peer => <View key={peer.peer} style={{ gap: 4 }}><Text style={{ color: t.text }}>{people[peer.userId]?.displayName || 'Участник'} · {peer.screen!.quality === '720p60' ? '720p · 60 FPS' : '1080p · 60 FPS'}</Text><ScreenVideo stream={peer.screen!.stream} /></View>)}
  </View>;
}
