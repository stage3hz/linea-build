import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, IconButton } from '../components';
import { GlassSurface } from '../glass';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { leaveVoice, toggleVoiceMute, useVoice } from './voice';

/** Strip shown everywhere while connected to a voice channel (as Discord's voice panel). */
export function VoiceBar({ onOpen }: { onOpen?: (communityId: string) => void }) {
  const t = useTheme(); const voice = useVoice();
  if (!voice) return null;
  const connected = voice.peers.filter(peer => peer.connected).length;
  return <GlassSurface lens radius={18} material="regular" shadow={false} style={{ marginHorizontal: 12, marginBottom: 6 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingLeft: 12, paddingRight: 4, gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Голосовой канал ${voice.channelName}`} onPress={() => onOpen?.(voice.communityId)} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: voice.status === 'connected' ? '#2FD27A' : '#F5C542' }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: voice.status === 'connected' ? '#2FD27A' : t.muted, fontSize: 13, fontWeight: '700' }}>{voice.status === 'connected' ? 'Голосовая связь' : 'Подключение…'}</Text>
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>{voice.channelName} · {voice.communityName}{voice.status === 'connected' ? ` · ${connected + 1} в канале` : ''}</Text>
      </View>
    </Pressable>
    <IconButton name={voice.muted ? 'mic-off' : 'mic'} label={voice.muted ? 'Включить микрофон' : 'Выключить микрофон'} color={voice.muted ? t.danger : t.text} onPress={toggleVoiceMute} size={21} />
    <Pressable accessibilityRole="button" accessibilityLabel="Отключиться" onPress={leaveVoice} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.danger, alignItems: 'center', justifyContent: 'center' }}><Icon name="call" size={18} color="#FFF" /></Pressable>
  </GlassSurface>;
}
