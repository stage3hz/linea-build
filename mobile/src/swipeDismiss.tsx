import React, { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Platform, ScrollView, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps } from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, scrollTo, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { motionEnabled } from './motion';
import { backdropOpacity, dismissDuration, followFinger, offscreenOffset, shouldDismiss } from './swipeDismissModel';

/**
 * Telegram's swipe down to close, for sheets, menus and full-screen overlays.
 *
 * Gesture Handler (not PanResponder): the pan runs on the UI thread and, for a panel with a scroll
 * view, recognises together with that scroll view's native gesture (`Gesture.Native`). The panel only
 * moves while the content is at its top; when the finger starts in a scrolled list, the list first
 * scrolls back to the top and the panel follows from there, like Telegram. While the panel is pulled
 * down the content is held at its top (no double movement). This is the same on iOS and Android,
 * where a JS responder could not take a touch back from a native scroll view.
 *
 * The content of a <Modal> needs its own GestureHandlerRootView for this to work.
 */
const SPRING = { damping: 22, stiffness: 260, mass: .8 } as const;

export type SwipeDismissOptions = {
  /** Runs once the panel has slid out: the same close the backdrop/close button uses. */
  onDismiss: () => void;
  /** The panel is shown. Opening again resets it; if the owner refuses to close (busy), it slides back. */
  visible?: boolean;
  /** False turns the gesture off (desktop popovers, a step that must not be skipped). Always off on web. */
  enabled?: boolean;
  /** The panel has a scroll view rendered with <SwipeDismissScrollView swipe={…}> (or `scrollProps`). */
  scrollable?: boolean;
};

export type SwipeDismiss = ReturnType<typeof useSwipeDismiss>;

export function useSwipeDismiss({ onDismiss, visible = true, enabled = true, scrollable = false }: SwipeDismissOptions) {
  const { height: screenHeight } = useWindowDimensions();
  const offset = useSharedValue(0), height = useSharedValue(0), scrollY = useSharedValue(0), anchor = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  // Opening again: back in place (it was left below the screen by the last swipe, so the close fade
  // did not show it jumping back).
  useEffect(() => { if (visible) { clear(); offset.value = 0; } }, [visible]);
  const dismissed = useCallback(() => {
    dismissRef.current();
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (visibleRef.current) offset.value = motionEnabled() ? withSpring(0, SPRING) : 0;
    }, 450);
  }, []);
  const motion = motionEnabled();
  const native = useMemo(() => Gesture.Native(), []);
  const live = enabled && Platform.OS !== 'web';
  const pan = Gesture.Pan()
    .enabled(live)
    .activeOffsetY(10)
    .failOffsetX([-20, 20])
    .onStart(event => { anchor.value = event.translationY; })
    .onUpdate(event => {
      // A scrolled list takes the drag first; the panel follows once it is at the top.
      if (scrollable && scrollY.value > .5 && offset.value <= 0) { anchor.value = event.translationY; return; }
      // With a list inside, a reverse drag scrolls the list: the panel stops at rest instead of rubber-banding up too.
      const next = scrollable ? Math.max(0, followFinger(event.translationY - anchor.value)) : followFinger(event.translationY - anchor.value);
      offset.value = next;
      if (scrollable && next > 0) scrollTo(scrollRef, 0, 0, false);
    })
    .onEnd(event => {
      if (shouldDismiss(offset.value, event.velocityY, height.value)) {
        const target = offscreenOffset(height.value, screenHeight);
        if (!motion) { offset.value = target; runOnJS(dismissed)(); return; }
        offset.value = withTiming(target, { duration: dismissDuration(offset.value, event.velocityY, target), easing: Easing.out(Easing.quad) }, done => { if (done) runOnJS(dismissed)(); });
      } else offset.value = motion ? withSpring(0, { ...SPRING, velocity: event.velocityY }) : 0;
    });
  const gesture = scrollable ? pan.simultaneousWithExternalGesture(native) : pan;
  const onScroll = useAnimatedScrollHandler({ onScroll: event => { scrollY.value = event.contentOffset.y; } });
  const onLayout = useCallback((event: LayoutChangeEvent) => { height.value = event.nativeEvent.layout.height; }, [height]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity(offset.value, height.value) }));
  return { gesture, native, offset, height, style, backdropStyle, onLayout, scrollRef, onScroll };
}

type AnimatedScrollProps = React.ComponentProps<typeof Animated.ScrollView>;

/** The scroll view of a swipe-dismissable panel: scrolls normally, hands the pull-down at its top to the panel. */
export function SwipeDismissScrollView({ swipe, ...props }: AnimatedScrollProps & { swipe: SwipeDismiss }) {
  return <GestureDetector gesture={swipe.native}>
    <Animated.ScrollView ref={swipe.scrollRef} onScroll={swipe.onScroll} scrollEventThrottle={16} bounces={false} overScrollMode="never" {...props} />
  </GestureDetector>;
}

/** Wraps a swipe-dismissable panel: it follows the finger and calls `onDismiss` once it is gone. */
export function SwipeDismissView({ swipe, style, children, ...props }: React.ComponentProps<typeof Animated.View> & { swipe: SwipeDismiss }) {
  return <GestureDetector gesture={swipe.gesture}>
    <Animated.View {...props} onLayout={swipe.onLayout} style={[style, swipe.style]}>{children}</Animated.View>
  </GestureDetector>;
}

/**
 * For a panel whose list lives in another component (the attachment gallery): the panel provides the
 * list's native gesture and an «at top» flag; the list spreads `useSwipeDismissEdge()` on its FlatList.
 * Without a provider the hook returns nothing and the list behaves as before.
 */
/** `connect` tells the panel a list has picked the edge up (its pan stays off until then). */
export type SwipeDismissEdge = { native: NativeGesture; atTop: SharedValue<boolean>; connect?: (connected: boolean) => void };
const EdgeContext = createContext<SwipeDismissEdge | null>(null);
export const SwipeDismissEdgeProvider = EdgeContext.Provider;

const NativeScroll = forwardRef<ScrollView, ScrollViewProps & { gesture: NativeGesture }>(({ gesture, ...props }, ref) =>
  <GestureDetector gesture={gesture}><ScrollView ref={ref} {...props} /></GestureDetector>);

export function useSwipeDismissEdge(): Partial<Pick<ScrollViewProps, 'onScroll' | 'scrollEventThrottle' | 'bounces' | 'overScrollMode'>> & { renderScrollComponent?: (props: ScrollViewProps) => React.ReactElement<ScrollViewProps> } {
  const edge = useContext(EdgeContext);
  useEffect(() => {
    if (!edge) return undefined;
    edge.atTop.value = true; edge.connect?.(true);
    return () => { edge.atTop.value = false; edge.connect?.(false); };
  }, [edge]);
  return useMemo(() => edge ? {
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => { edge.atTop.value = event.nativeEvent.contentOffset.y <= .5; },
    scrollEventThrottle: 16,
    bounces: false,
    overScrollMode: 'never' as const,
    renderScrollComponent: (props: ScrollViewProps) => <NativeScroll {...props} gesture={edge.native} />,
  } : {}, [edge]);
}
