// Floating tab bar like Telegram on iPhone: screens scroll UNDER the glass tab bar (it blurs them)
// instead of being cut off by a hard edge above it. Scrolling screens add `useTabInset()` to their
// bottom padding so the last row can still be scrolled clear of the bar.
import React, { createContext, useContext, useState } from 'react';
import { Platform, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { ScrollEdgeBlurView } from 'react-native-liquid-glassmorphism';
import { useReducedTransparency } from './glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';
import { tabBarEdge, tabBarMarginBottom } from './chatLayout';

const TabInset = createContext(0);
export const useTabInset = () => useContext(TabInset);

export function TabsOverlay({ tabs, children }: { tabs: React.ReactNode | null; children: React.ReactNode }) {
  const [height, setHeight] = useState(92);
  if (!tabs) return <>{children}</>;
  return <View style={{ flex: 1 }}>
    <TabInset.Provider value={height}>{children}</TabInset.Provider>
    <TabsFade bar={height} />
    <View pointerEvents="box-none" onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h && Math.abs(h - height) > 1) setHeight(h); }} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>{tabs}</View>
  </View>;
}

// Telegram / iOS 26: rows passing behind the floating tab bar dissolve into the page — nothing readable
// under the pill, beside its rounded ends or in the home-indicator strip below it (reported: a chat row,
// its avatar frame and its check mark peeked out there). Above the bar rows are untouched: a fade from
// higher up darkened readable rows (reported earlier).
function TabsFade({ bar }: { bar: number }) {
  // The overlay sits inside App's SafeAreaView: the status-bar strip is just above it, the home indicator just below.
  const t = useTheme(); const insets = useSafeAreaInsets();
  return <>
    <TabBarEdge bar={bar} />
    {insets.top && Platform.OS === 'ios' ? <ScrollEdgeBlurView pointerEvents="none" edge="top" maxBlurRadius={8} falloff={1} style={{ position: 'absolute', left: 0, right: 0, top: -insets.top, height: insets.top + 10 }} /> : null}
    {insets.top && Platform.OS !== 'web' ? <LinearGradient pointerEvents="none" colors={[tint(t.bg, Platform.OS === 'ios' ? .3 : .5, t.dark), tint(t.bg, 0, t.dark)]} style={{ position: 'absolute', left: 0, right: 0, top: -insets.top, height: insets.top }} /> : null}
  </>;
}

/**
 * The bottom scroll-edge effect of the floating tab bar (every tab: the chat list renders its own bar and
 * places this itself, the other tabs get it from TabsOverlay). A masked blur (iOS) and a page-colour
 * gradient from the screen bottom up to just above the bar — geometry in `tabBarEdge` (chatLayout.ts).
 * `bar`: measured height of the tab block above the safe area. Static native views, nothing per frame.
 */
export function TabBarEdge({ bar }: { bar: number }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const reduced = useReducedTransparency();
  const inset = Platform.OS === 'web' ? 0 : insets.bottom;
  const edge = tabBarEdge(bar, inset, inset + tabBarMarginBottom(Platform.OS === 'ios', insets.bottom));
  const up = { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } };
  const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };
  // Reduce Transparency: no blur, so the colour alone must hide the rows behind the bar.
  const alphas = reduced ? [1, 1, 1, .9, 0] : edge.alphas;
  return <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: -inset, height: edge.total }}>
    {Platform.OS === 'ios' && !reduced ? <MaskedView pointerEvents="none" style={fill} maskElement={<LinearGradient colors={['#000', '#000', 'transparent']} locations={[0, edge.blurSolid, 1]} {...up} style={{ flex: 1 }} />}>
      <BlurView intensity={30} tint={t.dark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'} style={{ flex: 1 }} />
    </MaskedView> : null}
    <LinearGradient pointerEvents="none" colors={alphas.map(alpha => tint(t.bg, alpha, t.dark)) as [string, string, ...string[]]} locations={edge.locations} {...up} style={fill} />
  </View>;
}
const isDarkColor = (color: string): boolean | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(color); if (!m) return null;
  const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < .5;
};
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
  const insets = useSafeAreaInsets(); const t = useTheme(); const [height, setHeight] = useState(0);
  const top = Platform.OS === 'web' ? 0 : insets.top;
  return <View pointerEvents="box-none" onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); setHeight(h); onHeight(h); }} style={{ position: 'absolute', top: -top, left: 0, right: 0, zIndex: 10, paddingTop: top }}>
    {/* Telegram / iOS 26 scroll-edge effect: rows passing under the status bar, the title, «Поиск» and the
        folder bar are blurred and covered by the background colour, then dissolve just below the header.
        The old progressive blur faded out linearly over the whole header, so behind «Поиск» it was almost
        gone and a scrolled-under row («Избранное») read through the clear glass as ghost text. */}
    {height ? <ScrollEdgeEffect edge="top" size={height} color={t.bg} alpha={Platform.OS === 'ios' ? .78 : .97} /> : null}
    {children}
  </View>;
}

/**
 * The scroll-edge effect of iOS 26 / Telegram behind floating bars (header pills, composer): content
 * under the bar is blurred (iOS) and covered by `color`, evenly over the bar, then dissolves across its
 * inner edge (14 pt inside to `fade` pt past it) — no hard line and no crisp text next to the glass.
 * Static native views only (a masked UIVisualEffectView and a gradient): nothing runs per frame.
 * `size`: the bar's height from the screen edge (status bar / home indicator included).
 * Android has no live blur here (a progressive blur re-captures the screen every frame and stuttered),
 * so the colour carries it; Reduce Transparency gets a solid band.
 */
/** How strong the colour cover of the edge effect is (the blur keeps its own strength, as in Telegram: blurred, barely tinted): 1 was the first cut, which read too dense under the bars on device. */
export const EDGE_STRENGTH = .3;

/** `cover`: how much of `alpha` the colour reaches right behind the bar (default EDGE_STRENGTH). A chat
 *  header passes more: text scrolling under its pills must not stay readable through them. */
export function ScrollEdgeEffect({ edge, size, color, alpha, fade = 8, zIndex, blur: strength, cover = EDGE_STRENGTH, style }: { edge: 'top' | 'bottom'; size: number; color: string; alpha: number; fade?: number; zIndex?: number; blur?: number; cover?: number; style?: object }) {
  const t = useTheme(); const reduced = useReducedTransparency();
  if (size <= 0) return null;
  const total = size + fade;
  // Fully covered up to 14 pt short of the bar's inner edge, then a soft ramp that ends `fade` pt past
  // it — inside the space the lists keep there, so at rest the first row / message is never covered.
  const solid = Math.max(0, Math.min(1, (size - 14) / total));
  const peak = reduced ? 1 : Math.min(1, alpha * cover);
  const colors = [tint(color, peak, t.dark), tint(color, peak * .9, t.dark), tint(color, peak * .45, t.dark), tint(color, 0, t.dark)] as const;
  const locations = [0, solid, solid + (1 - solid) * .45, 1] as const;
  const vertical = edge === 'top' ? { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } } : { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } };
  const box = { position: 'absolute' as const, left: 0, right: 0, height: total, zIndex, ...(edge === 'top' ? { top: 0 } : { bottom: 0 }) };
  const blur = Platform.OS === 'ios' && !reduced;
  // The material follows the edge colour, not only the theme: a dark wallpaper in the light theme gets a dark blur.
  const darkEdge = isDarkColor(color) ?? t.dark;
  return <View pointerEvents="none" style={[box, style]}>
    {blur ? <MaskedView pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} maskElement={<LinearGradient colors={['#000', '#000', 'transparent']} locations={[0, solid, Math.min(1, solid + (1 - solid) * .8)]} {...vertical} style={{ flex: 1 }} />}>
      <BlurView intensity={strength ?? (darkEdge ? 14 : 16)} tint={darkEdge ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'} style={{ flex: 1 }} />
    </MaskedView> : null}
    <LinearGradient pointerEvents="none" colors={colors} locations={locations} {...vertical} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
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
