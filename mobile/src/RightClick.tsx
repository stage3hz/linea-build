// PC: right click on the wrapped content runs `onMenu` (opens the same actions as a long press on phones).
import React, { useEffect, useRef } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
export function RightClick({ onMenu, style, children }: { onMenu: (x: number, y: number) => void; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const ref = useRef<View>(null); const fn = useRef(onMenu); fn.current = onMenu;
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !node?.addEventListener) return;
    const handler = (e: MouseEvent) => { e.preventDefault(); fn.current(e.clientX, e.clientY); };
    node.addEventListener('contextmenu', handler); return () => node.removeEventListener('contextmenu', handler);
  }, []);
  return <View ref={ref} style={style}>{children}</View>;
}
