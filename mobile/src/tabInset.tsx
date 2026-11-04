// Floating tab bar like Telegram on iPhone: screens scroll UNDER the glass tab bar (it blurs them)
// instead of being cut off by a hard edge above it. Scrolling screens add `useTabInset()` to their
// bottom padding so the last row can still be scrolled clear of the bar.
import React, { createContext, useContext, useState } from 'react';
import { View } from 'react-native';

const TabInset = createContext(0);
export const useTabInset = () => useContext(TabInset);

export function TabsOverlay({ tabs, children }: { tabs: React.ReactNode | null; children: React.ReactNode }) {
  const [height, setHeight] = useState(92);
  if (!tabs) return <>{children}</>;
  return <View style={{ flex: 1 }}>
    <TabInset.Provider value={height}>{children}</TabInset.Provider>
    <View pointerEvents="box-none" onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h && Math.abs(h - height) > 1) setHeight(h); }} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>{tabs}</View>
  </View>;
}

/** Header that floats over the scrolling content (content passes under its glass, no hard cut). */
export function FloatingHeader({ children, onHeight }: { children: React.ReactNode; onHeight: (h: number) => void }) {
  return <View pointerEvents="box-none" onLayout={e => onHeight(Math.round(e.nativeEvent.layout.height))} style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>{children}</View>;
}
