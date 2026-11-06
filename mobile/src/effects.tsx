// The expokit pieces the app uses (src/kit, MIT, by Karan / anshkaran7), dressed in the app's theme:
// confetti (Platina granted), skeleton rows (chat list loading), text that appears word by word
// (welcome and sign-in titles) and the button with states (sign-in and saving). With the app's
// animations turned off they show their final state at once.
import React, { useEffect, useState } from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { Text, FONT_FAMILY } from './typography';
import { useTheme } from './theme';
import { useMotion } from './motion';
import { tr, useLanguage } from './i18n';
import { KitProvider } from './kit/lib/kit';
import { Confetti as KitConfetti } from './kit/ui/confetti';
import { Skeleton, SkeletonGroup } from './kit/ui/skeleton';
import { AnimatedText } from './kit/ui/text-animation';
import { StatefulButton, type StatefulButtonState } from './kit/ui/stateful-button';

/** expokit components read colours, radius and font from this provider. */
export function AppKit({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <KitProvider scheme={t.dark ? 'dark' : 'light'} accent={t.accent} fontFamily={FONT_FAMILY} radius={14}>{children}</KitProvider>;
}

/** Confetti over the whole parent, fired once on mount. */
export function Confetti({ colors, onDone }: { colors: readonly string[]; onDone?: () => void }) {
  return <AppKit><KitConfetti autoplay origin="bottom" count={110} duration={2800} colors={colors} onDone={onDone} /></AppKit>;
}

const NAME_WIDTHS = ['58%', '42%', '66%', '50%', '36%', '62%', '47%', '55%', '40%'] as const;
const PREVIEW_WIDTHS = ['88%', '72%', '94%', '80%', '66%', '90%', '76%', '84%', '70%'] as const;

/** Placeholder rows shaped like the chat list rows (60 pt avatar, name, time, preview). */
export function ChatListSkeleton({ rows = 9 }: { rows?: number }) {
  const { enabled } = useMotion(); const variant = enabled ? 'shimmer' : 'static';
  return <AppKit><SkeletonGroup style={{ paddingTop: 4 }}>
    <View accessibilityLabel={tr('Загрузка чатов')} accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => <View key={i} style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center' }}>
        <Skeleton width={60} height={60} radius={21.6} variant={variant} />
        <View style={{ flex: 1, minHeight: 60, justifyContent: 'center', gap: 9 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Skeleton width={NAME_WIDTHS[i % NAME_WIDTHS.length]} height={14} radius="full" variant={variant} />
            <View style={{ flex: 1 }} />
            <Skeleton width={34} height={11} radius="full" variant={variant} />
          </View>
          <Skeleton width={PREVIEW_WIDTHS[(i + 3) % PREVIEW_WIDTHS.length]} height={12} radius="full" variant={variant} />
        </View>
      </View>)}
    </View>
  </SkeletonGroup></AppKit>;
}

/** Text whose words rise in one after another (expokit «reveal»); re-plays when the text changes. */
export function AppearingText({ children, style, delay = 0 }: { children: string; style?: StyleProp<TextStyle>; delay?: number }) {
  const { enabled } = useMotion(); const language = useLanguage(); const t = useTheme();
  if (!enabled) return <Text style={style}>{children}</Text>;
  // Each line is translated whole first (the dictionary holds whole phrases).
  const text = children.split('\n').map(line => tr(line, language)).join('\n');
  return <AppKit><AnimatedText variant="reveal" delay={delay} replayKey={text} color={t.text} style={{ alignSelf: 'stretch' }} textStyle={[{ fontFamily: FONT_FAMILY }, style]}>{text}</AnimatedText></AppKit>;
}

/**
 * The expokit button with states for sign-in and saving: a spinner while `loading`, a check mark and
 * `successLabel` while `success`, and a cross with «Ошибка» for a moment after each new error
 * (`errorSignal` changes to a truthy value).
 */
export function ActionButton({ label, onPress, loading = false, success = false, successLabel = 'Готово', errorSignal, disabled = false }: {
  label: string; onPress: () => void; loading?: boolean; success?: boolean; successLabel?: string; errorSignal?: unknown; disabled?: boolean;
}) {
  const t = useTheme(); const language = useLanguage();
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!errorSignal) return; setFailed(true); const timer = setTimeout(() => setFailed(false), 1400); return () => clearTimeout(timer); }, [errorSignal]);
  const state: StatefulButtonState = loading ? 'loading' : success ? 'success' : failed ? 'error' : 'idle';
  return <AppKit><StatefulButton state={state} onPress={onPress} disabled={disabled && state === 'idle'} size="lg" block pill color={t.accent}
    textStyle={{ fontWeight: '700' }} successText={tr(successLabel, language)} errorText={tr('Ошибка', language)} accessibilityLabel={tr(label, language)}>{tr(label, language)}</StatefulButton></AppKit>;
}
