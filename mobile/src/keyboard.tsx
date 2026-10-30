import React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

/**
 * Keeps the composer above the keyboard.
 *
 * Uses react-native-keyboard-controller: the padding follows the keyboard frame by frame
 * on the UI thread (the same curve as the system keyboard, including interactive
 * dismiss), instead of a LayoutAnimation on the JS thread that made the message list
 * jump. Its frame is measured in window coordinates, so safe-area containers and
 * Android edge-to-edge are handled.
 */
export function KeyboardSafeView({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  if (Platform.OS === 'web') return <View style={style}>{children}</View>;
  return <KeyboardAvoidingView behavior="padding" style={style}>{children}</KeyboardAvoidingView>;
}
