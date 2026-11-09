// Thin progress ring around a round video (Telegram): fills clockwise from 12 o'clock. The progress is a
// Reanimated shared value, so playback/recording ticks redraw only this SVG — never the message list.
import React from 'react';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { ringDash } from './playback';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function NoteRing({ progress, size, stroke = 3, color = '#FFF', track = 'rgba(255,255,255,0.22)', style }: { progress: SharedValue<number>; size: number; stroke?: number; color?: string; track?: string; style?: React.ComponentProps<typeof Animated.View>['style'] }) {
  const r = (size - stroke) / 2, c = size / 2;
  const animated = useAnimatedProps(() => {
    const dash = ringDash(progress.value, r);
    return { strokeDashoffset: dash.offset, strokeOpacity: progress.value > 0.001 ? 1 : 0 };
  });
  const length = ringDash(0, r).length;
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: size, height: size }, style]}>
    <Svg width={size} height={size}>
      {track !== 'transparent' ? <Circle cx={c} cy={c} r={r} stroke={track} strokeWidth={stroke} fill="none" /> : null}
      {/* rotate(-90): the stroke starts at 12 o'clock and runs clockwise. */}
      <AnimatedCircle cx={c} cy={c} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${length} ${length}`} animatedProps={animated} transform={`rotate(-90 ${c} ${c})`} />
    </Svg>
  </Animated.View>;
}
