import React, { createContext, useContext, memo, useCallback, useEffect, useRef } from 'react';
import { Keyboard, StyleSheet, View, useWindowDimensions, BackHandler } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, cancelAnimation, interpolate, makeMutable, runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withDelay, withTiming, type SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './typography';
import { useTheme } from './theme';
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
/** Inside a section of the phone's tab bar: the way straight back to «Чаты» (a long swipe back takes it). */
export const GoHome = createContext<(() => void) | null>(null);
/** How long the finger has to stay past the «leave» point of a swipe back for it to become «straight to Чаты». */
const LONG_HOLD_MS = 600;
/** How many pushed screens are on the page that is on screen: a section's own swipe to «Чаты» waits while there are any. */
const PUSHED = makeMutable(0);

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
  useEffect(() => { if (!visible) return; PUSHED.value = PUSHED.value + 1; return () => { PUSHED.value = Math.max(0, PUSHED.value - 1); }; }, [visible]);
  // A long swipe back: the finger stays past the «leave» point — the words «Отпусти — в чаты» appear and letting go
  // then goes straight to the chat list instead of one screen back.
  const home = useContext(GoHome); const homeRef = useRef(home); homeRef.current = home; const canHome = !!home;
  const goHome = useCallback(() => homeRef.current?.(), []);
  const long = useSharedValue(0); const armed = useSharedValue(0);
  useAnimatedReaction(() => long.value > 0.5, (now, before) => { if (now && !before) runOnJS(lightFeedback)(); });
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
    .onUpdate(event => {
      progress.value = Math.min(1, Math.max(0, event.translationX / width));
      if (!canHome) return;
      const far = event.translationX > width * 0.33;
      if (far && !armed.value) { armed.value = 1; long.value = withDelay(LONG_HOLD_MS, withTiming(1, { duration: 140 })); }
      else if (!far && armed.value) { armed.value = 0; cancelAnimation(long); long.value = withTiming(0, { duration: 100 }); }
    })
    .onEnd(event => {
      const straightHome = long.value > 0.5;
      armed.value = 0; cancelAnimation(long); long.value = withTiming(0, { duration: 120 });
      if (straightHome) runOnJS(goHome)();
      const leave = straightHome || event.translationX > width * 0.33 || event.velocityX > 700;
      if (leave) {
        runOnJS(dismissForLeave)();
        runOnJS(lightFeedback)();
        progress.value = withTiming(1, { duration: Math.max(90, 220 * (1 - progress.value)), easing: Easing.out(Easing.quad) }, done => { if (done) runOnJS(finish)(); });
      } else progress.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.quad) });
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * width }] }));
  const shadow = useAnimatedStyle(() => ({ opacity: interpolate(progress.value, [0, 1], [0.35, 0]) }));
  const homeWords = useAnimatedStyle(() => ({ opacity: long.value, transform: [{ scale: 0.9 + long.value * 0.1 }] }));
  return <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
    <GestureDetector gesture={pan}>
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, bottom: 0, left: -18, width: 18 }, shadow]}>
          <View style={{ flex: 1, backgroundColor: 'transparent', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: -2, height: 0 }, borderRightWidth: 1, borderRightColor: 'rgba(0,0,0,0.25)' }} />
        </Animated.View>
        <StackReady.Provider value={begin}>{children(back)}</StackReady.Provider>
      </Animated.View>
    </GestureDetector>
    {canHome ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 14, top: '46%' }, homeWords]}><HomePill words /></Animated.View> : null}
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

/** The mark of «to the chat list»: a round chat icon, with the words when the gesture needs telling. */
function HomePill({ words = false }: { words?: boolean }) {
  const t = useTheme();
  return <View style={{ height: 44, minWidth: 44, paddingHorizontal: words ? 14 : 0, borderRadius: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: t.text }}>
    <Ionicons name="chatbubbles" size={20} color={t.dark ? '#000' : '#FFF'} />
    {words ? <Text maxFontSizeMultiplier={1.2} style={{ color: t.dark ? '#000' : '#FFF', fontSize: 14, fontWeight: '700' }}>Отпусти — в чаты</Text> : null}
  </View>;
}

/**
 * A section of the tab bar (Каналы, Люди, Музыка, AI, Настройки) on a phone: a swipe to the right anywhere on
 * it goes back to «Чаты», with a round mark coming out of the left edge under the finger. While a screen is
 * pushed inside the section the swipe belongs to that screen (one step back), not to this.
 */
export function HomeSwipe({ onHome, children }: { onHome: () => void; children: React.ReactNode }) {
  const homeRef = useRef(onHome); homeRef.current = onHome;
  const go = useCallback(() => { dismissForLeave(); lightFeedback(); homeRef.current(); }, []);
  const start = useSharedValue({ x: 0, y: 0 }); const pull = useSharedValue(0);
  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesDown((event, manager) => { const touch = event.changedTouches[0]; if (!touch || PUSHED.value > 0) { manager.fail(); return; } start.value = { x: touch.absoluteX, y: touch.absoluteY }; })
    .onTouchesMove((event, manager) => {
      const touch = event.changedTouches[0]; if (!touch) return;
      const dx = touch.absoluteX - start.value.x, dy = Math.abs(touch.absoluteY - start.value.y);
      if (dx > 10 && dx > dy * 2) manager.activate();
      else if (dx < -10 || (dy > 10 && dy >= dx)) manager.fail();
    })
    .onUpdate(event => { pull.value = Math.max(0, event.translationX); })
    .onEnd(event => { if (event.translationX > 80 || event.velocityX > 700) runOnJS(go)(); })
    .onFinalize(() => { pull.value = withTiming(0, { duration: 160 }); });
  const mark = useAnimatedStyle(() => { const k = Math.min(1, pull.value / 80); return { opacity: k, transform: [{ translateX: -52 + Math.min(pull.value, 110) * 0.62 }, { scale: 0.7 + k * 0.3 }] }; });
  return <GestureDetector gesture={pan}>
    <View collapsable={false} style={{ flex: 1 }}>
      {children}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: '46%' }, mark]}><HomePill /></Animated.View>
    </View>
  </GestureDetector>;
}
