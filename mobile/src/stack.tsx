import React, { createContext, useContext, memo, useCallback, useEffect, useRef } from 'react';
import { Keyboard, StyleSheet, View, useWindowDimensions, BackHandler } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { lightFeedback } from './haptics';
import { RenderActivity } from './renderActivity';
import { stopFocusRetries } from './focusRetry';

/**
 * Telegram-style screen stack: the pushed screen (a chat, Избранное) slides in over
 * the chat list, which stays mounted underneath. A swipe to the right anywhere on the
 * pushed screen drags it away and reveals the list, entirely on the UI thread.
 *
 * `progress` is shared with the layer below: 0 = pushed screen fully open, 1 = closed.
 */
// Short, as in Telegram (Android slides a chat in over 150 ms, iOS settles in about 0.3 s): a long slide is
// where dropped frames get noticed.
const OPEN = { duration: 220, easing: Easing.bezier(0.2, 0.9, 0.25, 1) };
/** How long a screen that asked to be waited for may keep the slide from starting. Telegram for Android: 200 ms. */
const READY_WAIT_MS = 200;
const StackReady = createContext<() => void>(() => {});
/** Called by a pushed screen once its first content is on screen: the slide starts then, not before. */
export const useStackReady = () => useContext(StackReady);
const CLOSE = { duration: 240, easing: Easing.bezier(0.3, 0.1, 0.3, 1) };
/**
 * Telegram: the keyboard leaves together with the screen. Put it away as soon as leaving is decided
 * (back button, hardware back, a swipe released past the threshold), not after the slide: a focused
 * field of a screen that is removed does not always take the keyboard down with it on iOS, and it
 * stayed up over the chat list. Pending «Ответить»/«Изменить» focus retries are stopped first so
 * none of them raises it again during the slide. A swipe that springs back keeps the keyboard.
 */
export function dismissForLeave() { stopFocusRetries(); Keyboard.dismiss(); }

/** False inside a tab's page that is kept built but is not the one on screen. */
export const PageVisible = createContext(true);

export function StackScreen({ progress, onBack, children, waitReady = false }: { progress: SharedValue<number>; onBack: () => void; children: (back: () => void) => React.ReactNode; /** Hold the slide until the screen reports its first content (a chat: its first messages), at most READY_WAIT_MS. The screen mounting its rows while it slides is what dropped frames. */ waitReady?: boolean }) {
  const { width } = useWindowDimensions();
  const backRef = useRef(onBack); backRef.current = onBack;
  const closing = useRef(false);
  const finish = useCallback(() => backRef.current(), []);
  const started = useRef(false); const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const begin = useCallback(() => { if (started.current) return; started.current = true; if (waitTimer.current) { clearTimeout(waitTimer.current); waitTimer.current = undefined; } if (!closing.current) progress.value = withTiming(0, OPEN); }, [progress]);
  useEffect(() => {
    closing.current = false; started.current = false; progress.value = 1;
    if (waitReady) waitTimer.current = setTimeout(begin, READY_WAIT_MS); else begin();
    return () => { if (waitTimer.current) clearTimeout(waitTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);
  // Back button / hardware back: animate out, then actually leave the screen.
  const back = useCallback(() => {
    if (closing.current) return; closing.current = true;
    dismissForLeave();
    progress.value = withTiming(1, CLOSE, done => { if (done) runOnJS(finish)(); });
  }, [progress, finish]);
  // Android system back closes the top pushed screen first (e.g. Settings › Оформление returns to
  // Settings, not to Chats). Registered after the app-level handler, so it runs first.
  // A page kept built behind another tab must not catch the system «back» meant for the tab on screen.
  const visible = useContext(PageVisible);
  useEffect(() => { if (!visible) return; const sub = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; }); return () => sub.remove(); }, [back, visible]);
  // Direction lock like Telegram-iOS: the swipe takes over once the finger has moved right and mostly
  // sideways (2:1); a clearly vertical move (scrolling a list) lets it go. Fixed ±14 pt vertical
  // limits used to cancel the swipe on any slight wobble.
  const start = useSharedValue({ x: 0, y: 0 });
  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesDown((event, manager) => { const touch = event.changedTouches[0]; if (!touch) { manager.fail(); return; } start.value = { x: touch.absoluteX, y: touch.absoluteY }; })
    .onTouchesMove((event, manager) => {
      const touch = event.changedTouches[0]; if (!touch) return;
      const dx = touch.absoluteX - start.value.x, dy = Math.abs(touch.absoluteY - start.value.y);
      if (dx > 10 && dx > dy * 2) manager.activate();
      else if (dx < -10 || (dy > 10 && dy >= dx)) manager.fail();
    })
    .onUpdate(event => { progress.value = Math.min(1, Math.max(0, event.translationX / width)); })
    .onEnd(event => {
      const leave = event.translationX > width * 0.33 || event.velocityX > 700;
      if (leave) {
        runOnJS(dismissForLeave)();
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
        <StackReady.Provider value={begin}>{children(back)}</StackReady.Provider>
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
    <RenderActivity active={!covered}><Frozen frozen={covered}>{children}</Frozen></RenderActivity>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, dim]} />
  </Animated.View>;
}

/** While covered, the list underneath does not re-render on every keystroke or socket event. */
const Frozen = memo(({ children }: { frozen: boolean; children: React.ReactNode }) => <>{children}</>, (_previous, next) => next.frozen);
