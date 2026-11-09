// Horizontal strips (shared media tabs, search scopes) inside screens that close with a full-width
// swipe right. The strip tells the screen's back pan where its finger is and how far it is scrolled;
// the pan then leaves a rightward drag on a scrolled strip to the strip (decision: stripBlocksBack in
// src/listSwipes.ts). The edge swipe keeps working everywhere.
import React, { useMemo } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

export type BackStrip = { touching: SharedValue<number>; offset: SharedValue<number> };

export function useBackStrip(): BackStrip {
  const touching = useSharedValue(0); const offset = useSharedValue(0);
  return useMemo(() => ({ touching, offset }), [touching, offset]);
}

/** Props for the strip's ScrollView: keeps `offset` current. */
export function stripScrollProps(strip: BackStrip | undefined) {
  if (!strip) return {};
  return { scrollEventThrottle: 16, onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { strip.offset.value = e.nativeEvent.contentOffset.x; } };
}

/**
 * Wraps the strip's ScrollView (the direct child) in a native gesture that only reports touches: the
 * scroll view keeps scrolling as before, and `touching` is 1 while a finger is down on it.
 */
export function BackStripTouch({ strip, children }: { strip: BackStrip | undefined; children: React.ReactElement }) {
  // Touch callbacks, not onBegin: on iOS the native handler only begins once the scroll view itself
  // starts scrolling, too late for the back pan's decision. The back pan also clears `touching` when
  // it finishes, so a lost «up» cannot leave it set.
  const native = useMemo(() => strip ? Gesture.Native()
    .onTouchesDown(() => { strip.touching.value = 1; })
    .onTouchesUp(() => { strip.touching.value = 0; })
    .onTouchesCancelled(() => { strip.touching.value = 0; })
    .onFinalize(() => { strip.touching.value = 0; }) : null, [strip]);
  if (!native) return children;
  return <GestureDetector gesture={native}>{children}</GestureDetector>;
}
