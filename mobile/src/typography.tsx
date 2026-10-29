// App-wide typeface. Montserrat (SIL Open Font License 1.1) is embedded natively
// by the expo-font config plugin in app.config.js with weights 400–800, so the
// usual fontWeight values keep working on iOS and Android.
import React, { forwardRef } from 'react';
import { Text as RNText, TextInput as RNTextInput, StyleSheet, type TextInputProps, type TextProps } from 'react-native';

export const FONT_FAMILY = 'Montserrat';
const base = StyleSheet.create({ font: { fontFamily: FONT_FAMILY } });

// The base family comes first, so an explicit fontFamily (e.g. monospace for code) still wins.
export const Text = forwardRef<RNText, TextProps>(function Text({ style, ...props }, ref) {
  return <RNText ref={ref} {...props} style={[base.font, style]} />;
});
export type Text = RNText;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  return <RNTextInput ref={ref} {...props} style={[base.font, style]} />;
});
export type TextInput = RNTextInput;
