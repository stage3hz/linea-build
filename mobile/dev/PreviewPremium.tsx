// Dev-only: premium frames and statuses, for the video preview. Not part of the app. ?p=1 light, else dark.
import React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, palette } from '../src/theme';
import { Text } from '../src/typography';
import { PREMIUM_FRAMES, PREMIUM_STATUSES, PremiumFrame, PremiumStatus } from '../src/platina/Premium';

function Face({ size, hue }: { size: number; hue: [string, string] }) {
  return <View style={{ width: size, height: size, borderRadius: size * .36, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
    <LinearGradient colors={hue} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
    <Text style={{ color: '#FFFFFF', fontSize: size * .38, fontWeight: '800' }}>S</Text>
  </View>;
}
const HUES: [string, string][] = [['#2B2F3A', '#5B6475'], ['#123A4A', '#3B2A6B'], ['#4A1A12', '#7A3A1A'], ['#1A3350', '#2C5C8A'], ['#2A0F3A', '#0F2E4A'], ['#0B1B3F', '#2B3F7A']];

export default function PreviewPremium() {
  const light = typeof window !== 'undefined' && window.location.search.includes('p=1');
  const t = light ? palette.light : palette.dark;
  return <SafeAreaProvider><ThemeContext.Provider value={t}>
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 22, gap: 26 }}>
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '800' }}>Platina · рамки</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 34, columnGap: 10 }}>
        {PREMIUM_FRAMES.map((frame, index) => <View key={frame.id} style={{ width: 104, alignItems: 'center', gap: 16 }}>
          <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center' }}><PremiumFrame kind={frame.id} size={78}><Face size={78} hue={HUES[index]} /></PremiumFrame></View>
          <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>{frame.label}</Text>
        </View>)}
      </View>
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', marginTop: 6 }}>Platina · статусы</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 20, columnGap: 10 }}>
        {PREMIUM_STATUSES.map(status => <View key={status.id} style={{ width: 104, alignItems: 'center', gap: 10 }}>
          <PremiumStatus kind={status.id} size={56} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>stage</Text><PremiumStatus kind={status.id} size={18} /></View>
          <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>{status.label}</Text>
        </View>)}
      </View>
    </View>
  </ThemeContext.Provider></SafeAreaProvider>;
}
