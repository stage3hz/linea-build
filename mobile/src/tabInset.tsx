// Floating tab bar like Telegram on iPhone: screens scroll UNDER the glass tab bar (it blurs them)
// instead of being cut off by a hard edge above it. Scrolling screens add `useTabInset()` to their
// bottom padding so the last row can still be scrolled clear of the bar.
import React, { createContext, useContext, useState } from 'react';
import { Platform, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ScrollEdgeBlurView } from 'react-native-liquid-glassmorphism';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';

const TabInset = createContext(0);
export const useTabInset = () => useContext(TabInset);

export function TabsOverlay({ tabs, children }: { tabs: React.ReactNode | null; children: React.ReactNode }) {
  const [height, setHeight] = useState(92);
  if (!tabs) return <>{children}</>;
  return <View style={{ flex: 1 }}>
    <TabInset.Provider value={height}>{children}</TabInset.Provider>
    <TabsFade />
    <View pointerEvents="box-none" onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h && Math.abs(h - height) > 1) setHeight(h); }} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>{tabs}</View>
  </View>;
}

// Telegram: the content stays clear under the floating glass tab bar (the glass itself blurs it) and
// only fades into the background in the strip below the bar and under the status bar. It used to fade
// from above the bar, which darkened the bottom rows (reported on iPhone with the edges marked).
function TabsFade() {
  // The overlay sits inside App's SafeAreaView: the status-bar strip is just above it, the home indicator just below.
  const t = useTheme(); const insets = useSafeAreaInsets(); const extra = Platform.OS === 'web' ? 0 : insets.bottom;
  const below = extra ? 22 : 10; // the bar's bottom edge sits ~21 pt above the screen bottom on iPhones with a home indicator
  return <>
    <LinearGradient pointerEvents="none" colors={[tint(t.bg, 0, t.dark), tint(t.bg, .9, t.dark)]} style={{ position: 'absolute', left: 0, right: 0, bottom: -extra, height: below }} />
    {insets.top && Platform.OS === 'ios' ? <ScrollEdgeBlurView pointerEvents="none" edge="top" maxBlurRadius={20} falloff={1} style={{ position: 'absolute', left: 0, right: 0, top: -insets.top, height: insets.top + 10 }} /> : null}
    {insets.top && Platform.OS !== 'web' ? <LinearGradient pointerEvents="none" colors={[tint(t.bg, Platform.OS === 'ios' ? .5 : .75, t.dark), tint(t.bg, 0, t.dark)]} style={{ position: 'absolute', left: 0, right: 0, top: -insets.top, height: insets.top }} /> : null}
  </>;
}
const tint = (color: string, alpha: number, dark: boolean) => {
  const m = /^#([0-9a-f]{6})$/i.exec(color); if (!m) return dark ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/**
 * Header that floats over the scrolling content, as in Telegram: it reaches up under the status bar,
 * and the content passing under it fades out into the background (no hard cut, text under the clock and
 * the header pill is not readable). The reported height includes the status bar, so a scroll view that
 * itself starts under the status bar (`useBleed`) pads its content by exactly this height.
 */
export function FloatingHeader({ children, onHeight }: { children: React.ReactNode; onHeight: (h: number) => void }) {
  const insets = useSafeAreaInsets(); const t = useTheme();
  const top = Platform.OS === 'web' ? 0 : insets.top;
  return <View pointerEvents="box-none" onLayout={e => onHeight(Math.round(e.nativeEvent.layout.height))} style={{ position: 'absolute', top: -top, left: 0, right: 0, zIndex: 10, paddingTop: top }}>
    {/* iOS, like Telegram: a progressive system blur (strongest at the top, dissolving below the header)
        with a light tint, instead of a near-opaque slab. Android keeps the gradient: its progressive
        blur reads a software capture of the whole screen every frame, which is what made it stutter. */}
    {Platform.OS === 'ios' ? <>
      <ScrollEdgeBlurView pointerEvents="none" edge="top" maxBlurRadius={24} falloff={1} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: -30 }} />
      <LinearGradient pointerEvents="none" colors={[tint(t.bg, .62, t.dark), tint(t.bg, .38, t.dark), tint(t.bg, 0, t.dark)]} locations={[0, .6, 1]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: -30 }} />
    </> : <LinearGradient pointerEvents="none" colors={[tint(t.bg, .97, t.dark), tint(t.bg, .93, t.dark), tint(t.bg, 0, t.dark)]} locations={[0, .86, 1]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: -26 }} />}
    {children}
  </View>;
}

/** Scroll views under a FloatingHeader start under the status bar and end under the home indicator. */
export function useBleed() {
  const insets = useSafeAreaInsets();
  const top = Platform.OS === 'web' ? 0 : insets.top, bottom = Platform.OS === 'web' ? 0 : insets.bottom;
  return { style: { marginTop: -top, marginBottom: -bottom }, bottom };
}

/**
 * Two-pane layout (rail, chat list, chat) or the phone layout. Tablets and unfolded foldables get two
 * panes from 700 pt wide; a phone turned sideways (wide but low, e.g. 852×393) keeps the phone layout,
 * whose screens fit its height. The desktop/web app keeps its 850 px breakpoint.
 */
export function isWideLayout(width: number, height: number): boolean {
  return Platform.OS === 'web' ? width >= 850 : width >= 700 && height >= 500;
}
