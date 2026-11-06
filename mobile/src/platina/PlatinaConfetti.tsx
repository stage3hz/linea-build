// Confetti and a short «Платина активирована» banner when Platina is granted to the signed-in account
// (see onPlatinaGranted in usePlatina.ts). With animations turned off only the banner is shown.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { useMotion } from '../motion';
import { Confetti } from '../effects';
import { impactFeedback } from '../haptics';
import { GlassSurface } from '../glass';
import { onPlatinaGranted } from './usePlatina';

const COLORS = ['#E8E3D3', '#C9CED8', '#F4D68A', '#B9A7F5', '#8FD3FF', '#FFFFFF', '#F2A7C9'];

export function PlatinaConfettiHost({ owner }: { owner: string | null }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const { enabled } = useMotion();
  const [shown, setShown] = useState(0);
  useEffect(() => onPlatinaGranted(granted => { if (granted === owner) { impactFeedback(); setShown(value => value + 1); } }), [owner]);
  useEffect(() => { if (!shown) return; const timer = setTimeout(() => setShown(0), 3600); return () => clearTimeout(timer); }, [shown]);
  if (!shown) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 1000 }}>
    {enabled ? <Confetti key={shown} colors={COLORS} /> : null}
    <Animated.View entering={FadeInUp.springify().damping(16)} exiting={FadeOutUp} style={{ position: 'absolute', top: insets.top + 12, left: 0, right: 0, alignItems: 'center' }}>
      <GlassSurface material="regular" radius={22} contentStyle={{ paddingHorizontal: 18, paddingVertical: 11 }}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Платина активирована ✨</Text>
      </GlassSurface>
    </Animated.View>
  </View>;
}
