// The Telegram profile info card — «имя пользователя», «день рождения», «о себе» — one layout for the
// person's own profile (ProfileScreen) and for other people's (UserProfile): the same order, type sizes,
// paddings and hairline dividers on both.
import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './typography';
import { useTheme } from './theme';
import { formatBirthday } from './birthday';

/** A Telegram profile info row: a small grey label above the value. `raw`: the value is the person's text, not a UI string. */
export function InfoRow({ label, value, accent = false, divider = false, raw = true, onPress, hint }: { label: string; value: string; accent?: boolean; divider?: boolean; raw?: boolean; onPress?: () => void; hint?: string }) {
  const t = useTheme();
  return <Pressable disabled={!onPress} onPress={onPress} onLongPress={onPress} accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={`${label}: ${value}`} accessibilityHint={hint} style={({ pressed }) => ({ paddingHorizontal: 16, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    {divider ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} /> : null}
    <View style={{ paddingVertical: 11, gap: 2 }}><Text style={{ color: t.muted, fontSize: 14 }}>{label}</Text><Text raw={raw} selectable={!onPress} style={{ color: accent ? t.accent : t.text, fontSize: 17, lineHeight: 23 }}>{value}</Text></View>
  </Pressable>;
}

/**
 * The card itself. The username row copies on tap and reads «Скопировано» while `copied`; birthday and
 * bio show only when set. `children` go in a last row (UserProfile puts the end-to-end encryption line there).
 */
export function ProfileInfoCard({ username, birthday, bio, copied = false, onCopy, children, style }: { username: string; birthday?: string | null; bio?: string | null; copied?: boolean; onCopy?: () => void; children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ borderRadius: 22, backgroundColor: t.dark ? t.surface : '#FFFFFF', overflow: 'hidden' }, style]}>
    <InfoRow label="имя пользователя" value={copied ? 'Скопировано' : `@${username}`} raw={!copied} accent onPress={onCopy} hint="Нажми, чтобы скопировать" />
    {birthday ? <InfoRow label="день рождения" value={formatBirthday(birthday)} divider /> : null}
    {bio ? <InfoRow label="о себе" value={bio} divider /> : null}
    {children ? <View style={{ paddingHorizontal: 16 }}><View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} /><View style={{ paddingVertical: 11 }}>{children}</View></View> : null}
  </View>;
}
