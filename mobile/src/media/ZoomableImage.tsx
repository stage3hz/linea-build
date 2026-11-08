// A photo that zooms with a pinch and a double tap, and pans while zoomed — on iOS, Android and web
// alike (the iOS-only ScrollView zoom props did nothing elsewhere). Telegram: one tap toggles the
// chrome, two taps zoom to 2.5× around the finger, pinch up to 5×, a pinch below 1× springs back.
import React, { useRef } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageContentFit } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { MIN_SCALE, clampOffset, clampScale, doubleTapTarget, pinchTransform } from './zoomMath';

const SPRING = { damping: 22, stiffness: 240 };

export function ZoomableImage({ uri, style, contentFit = 'contain', transition, accessibilityLabel, onTap, onZoomChange, onError }: {
  uri: string; style?: StyleProp<ViewStyle>; contentFit?: ImageContentFit; transition?: number; accessibilityLabel?: string;
  /** A single tap (fires only when no double tap follows). */
  onTap?: () => void;
  /** `true` while the picture is larger than the box — the parent then stops paging and swipe-to-close. */
  onZoomChange?: (zoomed: boolean) => void;
  onError?: () => void;
}) {
  const width = useSharedValue(0), height = useSharedValue(0);
  const scale = useSharedValue(1), x = useSharedValue(0), y = useSharedValue(0);
  const baseScale = useSharedValue(1), baseX = useSharedValue(0), baseY = useSharedValue(0);
  const zoomed = useRef(false);
  const report = (value: number) => { const next = value > MIN_SCALE + 0.01; if (next !== zoomed.current) { zoomed.current = next; onZoomChange?.(next); } };
  const tap = () => onTap?.();

  const pinch = Gesture.Pinch()
    .onStart(() => { baseScale.value = scale.value; baseX.value = x.value; baseY.value = y.value; })
    .onUpdate(event => {
      const next = pinchTransform({ focalX: event.focalX, focalY: event.focalY, width: width.value, height: height.value, baseScale: baseScale.value, baseX: baseX.value, baseY: baseY.value, scale: baseScale.value * event.scale });
      scale.value = next.scale; x.value = next.x; y.value = next.y;
    })
    .onEnd(() => {
      // Report the value the spring settles on, not the 1.01…1.02 the fingers left: otherwise the
      // album paging and swipe-to-close stayed off after a pinch that visibly went back to 1×.
      const settled = scale.value <= MIN_SCALE + 0.02;
      if (settled) { scale.value = withSpring(MIN_SCALE, SPRING); x.value = withSpring(0, SPRING); y.value = withSpring(0, SPRING); }
      runOnJS(report)(settled ? MIN_SCALE : scale.value);
    });
  // Pans the zoomed picture; at 1× it fails at once so the album paging and swipe-to-close keep working.
  const pan = Gesture.Pan().maxPointers(1).manualActivation(true)
    .onTouchesMove((_event, state) => { if (scale.value > MIN_SCALE + 0.01) state.activate(); else state.fail(); })
    .onStart(() => { baseX.value = x.value; baseY.value = y.value; })
    .onUpdate(event => {
      x.value = clampOffset(baseX.value + event.translationX, scale.value, width.value);
      y.value = clampOffset(baseY.value + event.translationY, scale.value, height.value);
    });
  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(260)
    .onEnd(event => {
      const target = doubleTapTarget({ x: event.x, y: event.y, width: width.value, height: height.value, scale: scale.value });
      scale.value = withTiming(target.scale, { duration: 220 }); x.value = withTiming(target.x, { duration: 220 }); y.value = withTiming(target.y, { duration: 220 });
      runOnJS(report)(target.scale);
    });
  const singleTap = Gesture.Tap().numberOfTaps(1).maxDuration(260).requireExternalGestureToFail(doubleTap).onEnd(() => { runOnJS(tap)(); });
  const gesture = Gesture.Race(doubleTap, singleTap, Gesture.Simultaneous(pinch, pan));
  const transform = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: clampScale(scale.value) }] }));
  return <GestureDetector gesture={gesture}>
    <Animated.View style={[{ overflow: 'hidden' }, style]} onLayout={event => { width.value = event.nativeEvent.layout.width; height.value = event.nativeEvent.layout.height; }}>
      <Animated.View style={[StyleSheet.absoluteFill, transform]}>
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit={contentFit} transition={transition} accessibilityLabel={accessibilityLabel} onError={onError} />
      </Animated.View>
    </Animated.View>
  </GestureDetector>;
}
