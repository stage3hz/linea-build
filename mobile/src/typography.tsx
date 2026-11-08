// App-wide typeface. Montserrat (SIL Open Font License 1.1) is embedded natively
// by the expo-font config plugin in app.config.js with weights 400–800, so the
// usual fontWeight values keep working on iOS and Android.
import React, { forwardRef } from 'react';
import { Platform, Pressable as RNPressable, Text as RNText, TextInput as RNTextInput, StyleSheet, type PressableProps, type TextInputProps, type TextProps, type View } from 'react-native';
import { tr, trA11y, trChildren, useLanguage } from './i18n';

// In a browser the native font plugin does nothing: the faces are registered here with @font-face, and
// the family list falls back to the system sans-serif (it fell back to Times New Roman before).
export const FONT_FAMILY = Platform.OS === 'web' ? 'Montserrat, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : 'Montserrat';
if (Platform.OS === 'web' && typeof document !== 'undefined' && !document.getElementById('invizent-montserrat')) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Asset } = require('expo-asset') as typeof import('expo-asset');
    const faces: [number, number][] = [
      [require('../assets/fonts/Montserrat-Regular.ttf'), 400], [require('../assets/fonts/Montserrat-Medium.ttf'), 500],
      [require('../assets/fonts/Montserrat-SemiBold.ttf'), 600], [require('../assets/fonts/Montserrat-Bold.ttf'), 700],
      [require('../assets/fonts/Montserrat-ExtraBold.ttf'), 800],
    ];
    const style = document.createElement('style'); style.id = 'invizent-montserrat';
    style.textContent = faces.map(([module, weight]) => `@font-face{font-family:'Montserrat';src:url('${Asset.fromModule(module).uri}') format('truetype');font-weight:${weight};font-style:normal;font-display:swap}`).join('');
    document.head.appendChild(style);
  } catch { /* the system font stays */ }
}
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
// The spoken accessibilityLabel / accessibilityHint are interface text too and go through the same
// dictionary (a raw Text keeps its label as given: it describes user content).
export const Text = forwardRef<RNText, TextProps & { raw?: boolean }>(function Text({ style, maxFontSizeMultiplier = MAX_FONT_SCALE, children, raw = false, ...props }, ref) {
  const language = useLanguage();
  return <RNText ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} {...(raw ? null : trA11y(props, language))} style={[base.font, style]}>{raw ? children : trChildren(children, language) as React.ReactNode}</RNText>;
});
export type Text = RNText;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, maxFontSizeMultiplier = MAX_FONT_SCALE, placeholder, ...props }, ref) {
  const language = useLanguage();
  return <RNTextInput ref={ref} maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} {...trA11y(props, language)} placeholder={placeholder ? tr(placeholder, language) : placeholder} style={[base.font, style]} />;
});
export type TextInput = RNTextInput;

/** Drop-in for react-native's Pressable whose accessibilityLabel / accessibilityHint are translated like Text. */
export const Pressable = forwardRef<View, PressableProps>(function Pressable(props, ref) {
  const language = useLanguage();
  return <RNPressable ref={ref} {...props} {...trA11y(props, language)} />;
});
export type Pressable = View;
