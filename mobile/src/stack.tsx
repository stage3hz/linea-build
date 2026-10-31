import React, { memo, useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, useWindowDimensions, BackHandler } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, runOnJS, useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated';
import { lightFeedback } from './haptics';

/**
 * Telegram-style screen stack: the pushed screen (a chat, Избранное) slides in over
 * the chat list, which stays mounted underneath. A swipe to the right anywhere on the
 * pushed screen drags it away and reveals the list, entirely on the UI thread.
 *
 * `progress` is shared with the layer below: 0 = pushed screen fully open, 1 = closed.
 */
const OPEN = { duration: 300, easing: Easing.bezier(0.2, 0.9, 0.25, 1) };
const CLOSE = { duration: 240, easing: Easing.bezier(0.3, 0.1, 0.3, 1) };

export function StackScreen({ progress, onBack, children }: { progress: SharedValue<number>; onBack: () => void; children: (back: () => void) => React.ReactNode }) {
  const { width } = useWindowDimensions();
  const backRef = useRef(onBack); backRef.current = onBack;
  const closing = useRef(false);
  const finish = useCallback(() => backRef.current(), []);
  useEffect(() => { closing.current = false; progress.value = 1; progress.value = withTiming(0, OPEN); }, [progress]);
  // Back button / hardware back: animate out, then actually leave the screen.
  const back = useCallback(() => {
    if (closing.current) return; closing.current = true;
    progress.value = withTiming(1, CLOSE, done => { if (done) runOnJS(finish)(); });
  }, [progress, finish]);
  // Android system back closes the top pushed screen first (e.g. Settings › Оформление returns to
  // Settings, not to Chats). Registered after the app-level handler, so it runs first.
  useEffect(() => { const sub = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; }); return () => sub.remove(); }, [back]);
  const pan = Gesture.Pan()
    .activeOffsetX(14).failOffsetY([-14, 14])
    .onUpdate(event => { progress.value = Math.min(1, Math.max(0, event.translationX / width)); })
    .onEnd(event => {
      const leave = event.translationX > width * 0.33 || event.velocityX > 700;
      if (leave) {
        runOnJS(lightFeedback)();
        progress.value = withTiming(1, { duration: Math.max(90, 220 * (1 - progress.value)), easing: Easing.out(Easing.quad) }, done => { if (done) runOnJS(finish)(); });
      } else progress.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.quad) });
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * width }] }));
  const shadow = useAnimatedStyle(() => ({ opacity: interpolate(progress.value, [0, 1], [0.35, 0]) }));
  return <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
    <GestureDetector gesture={pan}>
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, bottom: 0, left: -18, width: 18 }, shadow]}>
          <View style={{ flex: 1, backgroundColor: 'transparent', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: -2, height: 0 }, borderRightWidth: 1, borderRightColor: 'rgba(0,0,0,0.25)' }} />
        </Animated.View>
        {children(back)}
      </Animated.View>
    </GestureDetector>
  </View>;
}

/** The layer under a pushed screen: slides slightly left and dims, as on iOS. */
export function StackBase({ progress, covered, children }: { progress: SharedValue<number>; covered: boolean; children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: covered ? interpolate(progress.value, [0, 1], [-width * 0.28, 0]) : 0 }] }));
  const dim = useAnimatedStyle(() => ({ opacity: covered ? interpolate(progress.value, [0, 1], [0.38, 0]) : 0 }));
  return <Animated.View style={[{ flex: 1 }, style]} pointerEvents={covered ? 'none' : 'auto'}>
    <Frozen frozen={covered}>{children}</Frozen>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, dim]} />
  </Animated.View>;
}

/** While covered, the list underneath does not re-render on every keystroke or socket event. */
const Frozen = memo(({ children }: { frozen: boolean; children: React.ReactNode }) => <>{children}</>, (_previous, next) => next.frozen);
