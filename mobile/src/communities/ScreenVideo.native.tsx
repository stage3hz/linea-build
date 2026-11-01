import React from 'react';
import { RTCView } from 'react-native-webrtc';
export function ScreenVideo({ stream }: { stream: any }) {
  return <RTCView streamURL={stream.toURL()} objectFit="contain" style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' }} />;
}
