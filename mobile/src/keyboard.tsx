import React, { useCallback, useRef } from 'react';
import { Dimensions, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';

/**
 * Keeps the composer right above the keyboard, frame by frame, on the UI thread.
 *
 * The keyboard height comes from react-native-keyboard-controller (it follows the system
 * keyboard curve, including interactive dismiss). The padding is the part of the keyboard
 * that actually overlaps this view, measured in WINDOW coordinates: a KeyboardAvoidingView
 * uses its layout relative to the parent, so inside a safe-area container (status bar,
 * home indicator, mini player below) it under-pads and the keyboard covers the composer.
 */
export function KeyboardSafeView({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  if (Platform.OS === 'web') return <View style={style}>{children}</View>;
  return <NativeKeyboardSafeView style={style}>{children}</NativeKeyboardSafeView>;
}

function NativeKeyboardSafeView({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const { height } = useReanimatedKeyboardAnimation(); // 0 … -keyboardHeight
  const below = useSharedValue(0); // distance from this view's bottom to the bottom of the window
  const ref = useRef<View>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _w, h) => {
      if (h > 0) below.value = Math.max(0, Dimensions.get('window').height - (y + h));
    });
  }, [below]);
  const padding = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -height.value - below.value) }));
  return <Animated.View ref={ref as never} onLayout={measure} style={[style, padding]}>{children}</Animated.View>;
}
