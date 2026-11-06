// Telegram's record button: tap switches microphone ↔ round video; press and hold records; while
// holding, slide left to cancel or up to lock (then the hands are free); releasing sends.
// The button stays in place vertically (Telegram): only a slide left moves it; dragging up
// pulls the lock pill down towards the button.
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Icon } from '../components';
import { useTheme } from '../theme';
import { impactFeedback, lightFeedback } from '../haptics';

// Telegram iOS: recording starts after 0.19 s; cancel at 150 pt left while moving (100 pt or a fast
// flick on release), lock at 110 pt up (60 pt or a fast flick on release); a quicker tap switches mode.
export const CANCEL_DISTANCE = 150, LOCK_DISTANCE = 110, HOLD_MS = 190;
const CANCEL_ON_RELEASE = 100, LOCK_ON_RELEASE = 60, FLICK = 400;
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
  const slide = (x: number) => props.current.onSlide?.(Math.min(1, Math.max(0, -x / CANCEL_DISTANCE)));
  const toggle = () => props.current.onToggleMode();
  // Release: the button settles back without bouncing (a spring here wobbled after a sharp release).
  const SETTLE = { duration: 180, easing: Easing.out(Easing.cubic) };
  const reset = () => { 'worklet'; tx.value = withTiming(0, SETTLE); ty.value = withTiming(0, SETTLE); active.value = withTiming(0, SETTLE); };

  const hold = Gesture.Pan().enabled(!disabled).activateAfterLongPress(HOLD_MS)
    .onBegin(() => { runOnJS(down)(); })
    .onStart(() => { active.value = withSpring(1, { damping: 20, stiffness: 260, overshootClamping: true }); runOnJS(begin)(); })
    .onUpdate(e => {
      // One axis at a time, like Telegram: the larger movement wins.
      const left = Math.min(0, e.translationX), up = Math.min(0, e.translationY);
      if (-left > -up) { tx.value = left; ty.value = 0; } else { ty.value = up; tx.value = 0; }
      runOnJS(slide)(tx.value);
      if (-tx.value >= CANCEL_DISTANCE) { reset(); runOnJS(finish)('cancel'); }
      else if (-ty.value >= LOCK_DISTANCE) { reset(); runOnJS(finish)('lock'); }
    })
    .onEnd(e => {
      const left = -Math.min(0, e.translationX), up = -Math.min(0, e.translationY);
      const result = left >= CANCEL_ON_RELEASE || e.velocityX < -FLICK ? 'cancel' : up >= LOCK_ON_RELEASE || e.velocityY < -FLICK ? 'lock' : 'send';
      reset(); runOnJS(finish)(result);
    })
    .onFinalize(() => { reset(); });
  const tap = Gesture.Tap().enabled(!disabled).maxDuration(HOLD_MS).onEnd((_e, ok) => { if (ok) runOnJS(toggle)(); });
  const gesture = Gesture.Exclusive(hold, tap);

  const button = useAnimatedStyle(() => ({
    // Telegram: at rest just the icon; while held a big accent circle (~2.3×) that reaches past the edge.
    transform: [{ translateX: tx.value * 0.9 }, { scale: 1 + active.value * 1.3 }],
    backgroundColor: active.value > 0.05 ? t.accent : 'transparent',
  }));
  // The light ring around the big circle, breathing with the voice (Telegram's halo).
  const halo = useAnimatedStyle(() => ({ opacity: active.value * 0.32, transform: [{ translateX: tx.value * 0.9 }, { scale: active.value * (1.85 + Math.min(1, level) * 0.5) }] }));
  const lockPill = useAnimatedStyle(() => ({ opacity: active.value, transform: [{ translateY: -70 - ty.value * 0.15 }, { scale: 0.8 + active.value * 0.2 }] }));

  return <View style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
    {holding ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 36, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'space-evenly', backgroundColor: t.glassOpaque, borderWidth: 1, borderColor: t.border }, lockPill]}>
      <Icon name="lock-open-outline" size={17} color={t.text} /><Icon name="chevron-up" size={14} color={t.muted} />
    </Animated.View> : null}
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 40, height: 40, borderRadius: 20, backgroundColor: t.accent }, halo]} />
    <GestureDetector gesture={gesture}>
      <Animated.View accessible accessibilityRole="button" accessibilityLabel={mode === 'voice' ? 'Голосовое: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на видео' : 'Видеосообщение: удерживай для записи, свайп влево — отмена, вверх — без рук. Нажми — переключить на голосовое'}
        style={[{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }, button]}>
        <Icon name={mode === 'voice' ? (holding ? 'mic' : 'mic-outline') : (holding ? 'videocam' : 'videocam-outline')} color={holding ? t.onAccent : t.text} size={holding ? 20 : 25} />
      </Animated.View>
    </GestureDetector>
  </View>;
}
