// Telegram: a full-screen photo / video / file follows the finger up or down, shrinks a little and the
// backdrop fades; let go far enough (or flick) and it flies off and closes, otherwise it springs back.
// The same feel as MediaGallery (AttachmentViewer.tsx), shared by the single-file viewer and the profile
// photos. Decisions are in swipeMath.ts.
import { useRef } from 'react';
import { useWindowDimensions } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { motionEnabled } from '../motion';
import { dismissProgress, shouldDismiss } from './swipeMath';

const SPRING = { damping: 20, stiffness: 260 };

export function useSwipeDismiss({ onDismiss, enabled = true, minScale = 0.86 }: { onDismiss: () => void; enabled?: boolean; minScale?: number }) {
  const { height } = useWindowDimensions();
  const y = useSharedValue(0);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const finish = () => dismiss.current();
  // Read on each render: «Анимации: выкл» / power saving makes the fly-off and spring-back instant
  // (the drag itself still follows the finger — that is direct manipulation, not an animation).
  const motion = motionEnabled();
  // One finger only, so a two-finger pinch never starts a dismiss; a sideways move is left to paging.
  const gesture = Gesture.Pan().enabled(enabled).maxPointers(1).activeOffsetY([-14, 14]).failOffsetX([-16, 16])
    .onUpdate(event => { y.value = event.translationY; })
    .onEnd(event => {
      if (shouldDismiss(event.translationY, event.velocityY)) {
        const target = event.translationY > 0 || (event.translationY === 0 && event.velocityY > 0) ? height : -height;
        if (!motion) { y.value = target; runOnJS(finish)(); return; }
        y.value = withTiming(target, { duration: 170 }, done => { if (done) runOnJS(finish)(); });
      } else y.value = motion ? withSpring(0, SPRING) : 0;
    });
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }, { scale: interpolate(dismissProgress(y.value, height), [0, 1], [1, minScale], 'clamp') }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: interpolate(dismissProgress(y.value, height), [0, 1], [1, 0.15], 'clamp') }));
  /** Floating controls disappear early in the drag, as in Telegram. */
  const chromeStyle = useAnimatedStyle(() => ({ opacity: interpolate(Math.abs(y.value), [0, 90], [1, 0], 'clamp') }));
  const reset = () => { y.value = 0; };
  return { gesture, contentStyle, backdropStyle, chromeStyle, reset, offset: y };
}
