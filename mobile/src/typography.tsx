// App-wide typeface. Montserrat (SIL Open Font License 1.1) is embedded natively
// by the expo-font config plugin in app.config.js with weights 400–800, so the
// usual fontWeight values keep working on iOS and Android.
import React, { forwardRef } from 'react';
import { Platform, Text as RNText, TextInput as RNTextInput, StyleSheet, type TextInputProps, type TextProps } from 'react-native';
import { tr, trChildren, useLanguage } from './i18n';

export const FONT_FAMILY = 'Montserrat';
/** The system monospaced face (technical lines, key hints). */
export const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' })!;
const base = StyleSheet.create({ font: { fontFamily: FONT_FAMILY } });

// System "larger text" is honoured, but capped: without a cap a 2x system font blew past the
// fixed-height bars, pills and tab labels and clipped. 1.25 keeps those readable without breaking
// the layout. A caller can still pass its own maxFontSizeMultiplier to override.
const MAX_FONT_SCALE = 1.25;

// The base family comes first, so an explicit fontFamily (e.g. monospace for code) still wins.
// Interface strings are shown in the chosen language (src/i18n). `raw` marks user content
// (message text, names): it is never translated, even if it happens to equal an interface string.
export const Text = forwardRef<RNText, TextProps & { raw?: boolean }>(function Text({ style, maxFontSizeMultiplier = MAX_FONT_SCALE, children, raw = false, ...props }, ref) {
  const language = useLanguage();
  return <RNText ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} style={[base.font, style]}>{raw ? children : trChildren(children, language) as React.ReactNode}</RNText>;
});
export type Text = RNText;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, maxFontSizeMultiplier = MAX_FONT_SCALE, placeholder, ...props }, ref) {
  const language = useLanguage();
  return <RNTextInput ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} placeholder={placeholder ? tr(placeholder, language) : placeholder} style={[base.font, style]} />;
});
export type TextInput = RNTextInput;
