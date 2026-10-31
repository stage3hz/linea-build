// App-wide typeface. Montserrat (SIL Open Font License 1.1) is embedded natively
// by the expo-font config plugin in app.config.js with weights 400–800, so the
// usual fontWeight values keep working on iOS and Android.
import React, { forwardRef } from 'react';
import { Text as RNText, TextInput as RNTextInput, StyleSheet, type TextInputProps, type TextProps } from 'react-native';

export const FONT_FAMILY = 'Montserrat';
const base = StyleSheet.create({ font: { fontFamily: FONT_FAMILY } });

// System "larger text" is honoured, but capped: without a cap a 2x system font blew past the
// fixed-height bars, pills and tab labels and clipped. 1.25 keeps those readable without breaking
// the layout. A caller can still pass its own maxFontSizeMultiplier to override.
const MAX_FONT_SCALE = 1.25;

// The base family comes first, so an explicit fontFamily (e.g. monospace for code) still wins.
export const Text = forwardRef<RNText, TextProps>(function Text({ style, maxFontSizeMultiplier = MAX_FONT_SCALE, ...props }, ref) {
  return <RNText ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} style={[base.font, style]} />;
});
export type Text = RNText;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, maxFontSizeMultiplier = MAX_FONT_SCALE, ...props }, ref) {
  return <RNTextInput ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} style={[base.font, style]} />;
});
export type TextInput = RNTextInput;
