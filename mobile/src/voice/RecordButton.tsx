// Telegram's record button: tap switches microphone ↔ round video; press and hold records; while
// holding, slide left to cancel or up to lock (then the hands are free); releasing sends.
// The button stays in place vertically (Telegram): only a slide left moves it; dragging up
// pulls the lock pill down towards the button.
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Icon } from '../components';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { impactFeedback, lightFeedback } from '../haptics';

import { HOLD_MS, holdAxis, holdMove, holdRelease, slideStep } from '../videonote/recordGesture';
// Telegram iOS: recording starts after 0.19 s; cancel at 150 pt left while moving (100 pt or a fast
// flick on release), lock at 110 pt up (60 pt or a fast flick on release); a quicker tap switches mode.
// The rules live in videonote/recordGesture.ts (pure, tested).
export { CANCEL_DISTANCE, LOCK_DISTANCE, HOLD_MS } from '../videonote/recordGesture';
export type RecordKind = 'voice' | 'video';

export function RecordButton({ mode, disabled, onToggleMode, onTouchDown, onHoldStart, onHoldEnd, onLock, onSlide, level = 0 }: {
  mode: RecordKind; disabled?: boolean;
  /** 0…1 loudness right now: the halo around the big circle breathes with the voice (Telegram). */
  level?: number;
  onToggleMode: () => void;
  /** Finger touched the button (before the hold delay): a chance to warm up the microphone. */
  onTouchDown?: () => void;
  /** Recording should begin (finger is down long enough). */
  onHoldStart: () => void;
  /** Finger lifted: 'send' (normal release), 'cancel' (slid left). Not called after a lock. */
  onHoldEnd: (result: 'send' | 'cancel') => void;
  onLock: () => void;
  /** 0…1 progress of the cancel slide, for the «‹ Влево — отмена» hint. */
  onSlide?: (cancel: number) => void;
}) {
  const t = useTheme();
  const tx = useSharedValue(0), ty = useSharedValue(0), active = useSharedValue(0);
  // Last cancel-slide step sent to JS: the chat screen re-renders on a 5 % step, not on every touch move.
  const sentSlide = useSharedValue(0);
  const [holding, setHolding] = useState(false);
  const done = useRef(false);
  // The gesture worklets keep the functions of the render they were attached in; going through a ref
  // always reaches the current props (otherwise a hold right after «tap → video» still recorded voice).
  const props = useRef({ onHoldStart, onHoldEnd, onLock, onSlide, onToggleMode, onTouchDown });
  props.current = { onHoldStart, onHoldEnd, onLock, onSlide, onToggleMode, onTouchDown };
  const down = () => props.current.onTouchDown?.();
  const begin = () => { done.current = false; setHolding(true); impactFeedback(); props.current.onHoldStart(); };
  const finish = (result: 'send' | 'cancel' | 'lock') => {
    if (done.current) return; done.current = true; setHolding(false); props.current.onSlide?.(0);
    if (result === 'lock') { lightFeedback(); props.current.onLock(); } else props.current.onHoldEnd(result);
  };
  const slide = (step: number) => props.current.onSlide?.(step);
  const toggle = () => props.current.onToggleMode();
  // Release: the button settles back without bouncing (a spring here wobbled after a sharp release).
  const SETTLE = { duration: 180, easing: Easing.out(Easing.cubic) };
  const reset = () => { 'worklet'; tx.value = withTiming(0, SETTLE); ty.value = withTiming(0, SETTLE); active.value = withTiming(0, SETTLE); };

  const hold = Gesture.Pan().enabled(!disabled).activateAfterLongPress(HOLD_MS)
    .onBegin(() => { runOnJS(down)(); })
    .onStart(() => { active.value = withSpring(1, { damping: 20, stiffness: 260, overshootClamping: true }); runOnJS(begin)(); })
    .onUpdate(e => {
      // One axis at a time, like Telegram: the larger movement wins.
      const axis = holdAxis(e.translationX, e.translationY);
      tx.value = axis.x; ty.value = axis.y;
      const step = slideStep(axis.x);
      if (step !== sentSlide.value) { sentSlide.value = step; runOnJS(slide)(step); }
      const result = holdMove(axis.x, axis.y);
      if (result) { sentSlide.value = 0; reset(); runOnJS(finish)(result); }
    })
    .onEnd(e => {
      const result = holdRelease(e.translationX, e.translationY, e.velocityX, e.velocityY);
      sentSlide.value = 0; reset(); runOnJS(finish)(result);
    })
    .onFinalize(() => { reset(); });
  const tap = Gesture.Tap().enabled(!disabled).maxDuration(HOLD_MS).onEnd((_e, ok) => { if (ok) runOnJS(toggle)(); });
  const gesture = Gesture.Exclusive(hold, tap);

  const button = useAnimatedStyle(() => ({
    // Telegram: at rest just the icon; while held a 100 pt accent circle (2.5×) that reaches past the edge.
    transform: [{ translateX: tx.value * 0.9 }, { scale: 1 + active.value * 1.5 }],
    backgroundColor: active.value > 0.05 ? t.accent : 'transparent',
  }));
  // The light ring around the big circle, breathing with the voice (Telegram's halo).
  // A thin ring just outside the circle, moving with the voice (measured on Telegram: 112 pt around 100 pt).
  const halo = useAnimatedStyle(() => ({ opacity: active.value * 0.5, transform: [{ translateX: tx.value * 0.9 }, { scale: active.value * (2.8 + Math.min(1, level) * 0.34) }] }));
  // The lock pill stands 105 pt above the circle's centre, where the pause button is after a lock.
  const lockPill = useAnimatedStyle(() => ({ opacity: active.value, transform: [{ translateY: -105 - ty.value * 0.15 }, { scale: 0.8 + active.value * 0.2 }] }));

  return <View style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
    {holding ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 40, height: 66, borderRadius: 20, alignItems: 'center', justifyContent: 'space-evenly', backgroundColor: t.glassOpaque, borderWidth: 1, borderColor: t.border }, lockPill]}>
      <Icon name="lock-open-outline" size={17} color={t.text} /><Icon name="chevron-up" size={14} color={t.muted} />
    </Animated.View> : null}
    {/* Telegram: at rest the mic sits in the same glass circle as the paperclip. */}
    {!holding ? <View pointerEvents="none" style={{ position: 'absolute', width: 40, height: 40 }}><GlassSurface material="regular" radius={20} contentStyle={{ width: 40, height: 40 }}><View /></GlassSurface></View> : null}
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 40, height: 40, borderRadius: 20, borderWidth: 0.7, borderColor: t.accent }, halo]} />
    <GestureDetector gesture={gesture}>
      <Animated.View accessible accessibilityRole="button" accessibilityLabel={mode === 'voice' ? 'Голосовое: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на видео' : 'Видеосообщение: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на голосовое'}
        style={[{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }, button]}>
        {/* Telegram: the held circle shows the send arrow (the circle is drawn 2.5× here, so 13 → 32 pt). */}
        <Icon name={holding ? (mode === 'voice' ? 'arrow-up' : 'videocam') : (mode === 'voice' ? 'mic-outline' : 'videocam-outline')} color={holding ? t.onAccent : t.text} size={holding ? (mode === 'voice' ? 13 : 17) : 24} />
      </Animated.View>
    </GestureDetector>
  </View>;
}
