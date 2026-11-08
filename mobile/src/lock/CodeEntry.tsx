// The code-entry surface shared by the lock screen and the passcode settings: Telegram's dots and
// numeric pad for a 4-digit code, a password field otherwise; the whole thing shakes and clears on a
// wrong code.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { Text, TextInput } from '../typography';
import { Bouncy, Icon, type IconName } from '../components';
import { GlassSurface } from '../glass';
import { useTheme } from '../theme';
import { errorFeedback, tapFeedback } from '../haptics';
import { DIGITS_LENGTH, type CodeKind } from './model';

export type CodeEntryProps = {
  kind: CodeKind;
  title: string;
  /** Quiet line under the title (what this step is for, or how long to wait). */
  hint?: string;
  /** Red line: a wrong code, codes that do not match. */
  error?: string;
  /** Change the value to shake the entry (a wrong code) — it clears what was typed and buzzes. */
  shake: number;
  /** Change the value to clear what was typed quietly (the first code was taken, now «Повтори»). */
  clear?: number;
  /** Nothing can be typed (waiting after wrong guesses, checking a code). */
  disabled?: boolean;
  /** A 4-digit code is sent as soon as the fourth digit is typed; a password on «Готово» / Enter. */
  onSubmit: (code: string) => void;
  /** Bottom-left pad key (Face ID / Touch ID / fingerprint). */
  biometric?: { icon: IconName; label: string; onPress: () => void } | null;
  footer?: React.ReactNode;
};

export function CodeEntry({ kind, title, hint, error, shake, clear = 0, disabled = false, onSubmit, biometric, footer }: CodeEntryProps) {
  const t = useTheme();
  const [code, setCode] = useState('');
  const offset = useSharedValue(0);
  const shaking = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const firstShake = useRef(true);
  useEffect(() => {
    if (firstShake.current) { firstShake.current = false; return; }
    setCode('');
    errorFeedback();
    offset.value = withSequence(withTiming(-14, { duration: 45 }), withTiming(12, { duration: 70 }), withTiming(-9, { duration: 70 }), withTiming(6, { duration: 60 }), withTiming(0, { duration: 50 }));
  }, [shake, offset]);
  const firstClear = useRef(true);
  useEffect(() => {
    if (firstClear.current) { firstClear.current = false; return; }
    setCode('');
  }, [clear]);
  // A new kind (digits ↔ password) starts over.
  useEffect(() => { setCode(''); }, [kind]);
  const submitRef = useRef(onSubmit); submitRef.current = onSubmit;
  // The fourth digit sends the code by itself — after the dot has been drawn, as on Telegram's pad.
  useEffect(() => {
    if (kind !== 'digits' || code.length !== DIGITS_LENGTH) return;
    const timer = setTimeout(() => submitRef.current(code), 60);
    return () => clearTimeout(timer);
  }, [kind, code]);
  const press = (digit: string) => {
    if (disabled || kind !== 'digits') return;
    tapFeedback();
    setCode(current => current.length >= DIGITS_LENGTH ? current : current + digit);
  };
  const erase = () => { if (!disabled) { tapFeedback(); setCode(current => current.slice(0, -1)); } };
  // PC / web: the keyboard types into the pad.
  useEffect(() => {
    if (Platform.OS !== 'web' || kind !== 'digits' || typeof window === 'undefined') return;
    const key = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); erase(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [kind, disabled]);
  return <View style={{ alignItems: 'center', gap: 18, width: '100%' }}>
    <View style={{ alignItems: 'center', gap: 8, paddingHorizontal: 24 }}>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.3, textAlign: 'center' }}>{title}</Text>
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.danger, fontSize: 14, textAlign: 'center' }}>{error}</Text> : hint ? <Text accessibilityLiveRegion="polite" style={{ color: t.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>{hint}</Text> : null}
    </View>
    <Animated.View style={[{ alignItems: 'center', width: '100%' }, shaking]}>
      {kind === 'digits'
        ? <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`Введено цифр: ${code.length} из ${DIGITS_LENGTH}`} style={{ flexDirection: 'row', gap: 20, paddingVertical: 10 }}>
          {Array.from({ length: DIGITS_LENGTH }, (_, i) => <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: error ? t.danger : t.text, backgroundColor: i < code.length ? (error ? t.danger : t.text) : 'transparent' }} />)}
        </View>
        : <View style={{ width: '100%', maxWidth: 340, paddingHorizontal: 24 }}>
          <GlassSurface radius={18} material="regular" shadow={false}>
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 18, borderWidth: 1.4, borderColor: error ? t.danger : t.accent }]} />
            {/* oneTimeCode + autoComplete off: the app's own code must not be offered to the system password manager. */}
            <TextInput value={code} onChangeText={setCode} editable={!disabled} autoFocus secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="oneTimeCode" autoComplete="off" importantForAutofill="no" returnKeyType="done" placeholder="Пароль" placeholderTextColor={t.subtle} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'} onSubmitEditing={() => { if (code && !disabled) onSubmit(code); }} accessibilityLabel={title} style={{ minHeight: 54, paddingHorizontal: 17, paddingVertical: 14, color: t.text, fontSize: 17, textAlign: 'center', letterSpacing: 2 }} />
          </GlassSurface>
        </View>}
    </Animated.View>
    {kind === 'digits' ? <View style={{ gap: 16, opacity: disabled ? 0.5 : 1 }}>
      {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map(row => <View key={row[0]} style={{ flexDirection: 'row', gap: 22 }}>{row.map(digit => <PadKey key={digit} label={digit} onPress={() => press(digit)} disabled={disabled} />)}</View>)}
      <View style={{ flexDirection: 'row', gap: 22 }}>
        {biometric ? <PadKey icon={biometric.icon} accessibilityLabel={biometric.label} onPress={biometric.onPress} disabled={disabled} quiet /> : <View style={{ width: KEY, height: KEY }} />}
        <PadKey label="0" onPress={() => press('0')} disabled={disabled} />
        {code.length ? <PadKey icon="backspace-outline" accessibilityLabel="Стереть" onPress={erase} disabled={disabled} quiet /> : <View style={{ width: KEY, height: KEY }} />}
      </View>
    </View> : <View style={{ width: '100%', maxWidth: 340, paddingHorizontal: 24, gap: 12 }}>
      <Pressable accessibilityRole="button" disabled={disabled || !code} onPress={() => onSubmit(code)} style={({ pressed }) => ({ minHeight: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent, opacity: disabled || !code ? 0.45 : pressed ? 0.8 : 1 })}><Text style={{ color: t.onAccent, fontSize: 16, fontWeight: '700' }}>Готово</Text></Pressable>
      {biometric ? <Pressable accessibilityRole="button" disabled={disabled} onPress={biometric.onPress} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Icon name={biometric.icon} size={20} color={t.accent} /><Text style={{ color: t.accent, fontSize: 15, fontWeight: '600' }}>{biometric.label}</Text></Pressable> : null}
    </View>}
    {footer}
  </View>;
}

const KEY = 74;
function PadKey({ label, icon, accessibilityLabel, onPress, disabled, quiet = false }: { label?: string; icon?: IconName; accessibilityLabel?: string; onPress: () => void; disabled: boolean; quiet?: boolean }) {
  const t = useTheme();
  return <Bouncy scaleTo={0.88} accessibilityRole="button" accessibilityLabel={accessibilityLabel || label} disabled={disabled} onPress={onPress} style={{ width: KEY, height: KEY, borderRadius: KEY / 2 }}>
    {quiet ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{icon ? <Icon name={icon} size={28} color={t.text} /> : null}</View>
      : <GlassSurface radius={KEY / 2} material="clear" interactive shadow={false} style={{ width: KEY, height: KEY }} contentStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text raw style={{ color: t.text, fontSize: 30, fontWeight: '500', letterSpacing: -0.5 }}>{label}</Text>
      </GlassSurface>}
  </Bouncy>;
}
