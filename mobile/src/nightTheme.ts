// Telegram «Ночная тема»: when the night theme is on. The rule lives in themePreference.ts (tested);
// this hook feeds it the clock (schedule) and the screen brightness (automatic), and keeps the
// «Ночной режим» switch — a manual choice holds until the automatic rule changes by itself.
import { useEffect, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { setChatPreferences, useChatPreferences } from './chatPreferences';
import { autoNight, effectiveNightMode, manualNightExpired } from './themePreference';
import type { ThemeMode } from './types';

/**
 * `night` — the night theme is on (by hand or by the rule); `auto` — what the rule alone says;
 * `known` — the rule has its input (by brightness the first reading takes a moment). One hook
 * instance feeds the whole app: the screens take it as a prop, so there is one brightness poller
 * and every switch, card and label agrees on the same frame.
 */
export type NightState = { night: boolean; auto: boolean; known: boolean };

/** Day, rule known: for screens mounted on their own (dev previews) without the App's hook above them. */
export const DAY_STATE: NightState = { night: false, auto: false, known: true };

export function useNightState(mode: ThemeMode): NightState {
  const system = useColorScheme();
  const preferences = useChatPreferences();
  const settings = { mode: preferences.nightMode, from: preferences.nightFrom, to: preferences.nightTo, brightness: preferences.nightBrightness };
  const kind = effectiveNightMode(settings, mode, Platform.OS);
  const [now, setNow] = useState(() => new Date());
  const [brightness, setBrightness] = useState<number | null>(null);
  useEffect(() => {
    if (kind !== 'schedule' && kind !== 'auto') return;
    const tick = () => {
      setNow(new Date());
      if (kind === 'auto') void import('expo-brightness').then(module => module.getBrightnessAsync()).then(setBrightness).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, kind === 'auto' ? 15_000 : 30_000);
    return () => clearInterval(timer);
  }, [kind]);
  const auto = autoNight(settings, mode, system, now, brightness, Platform.OS);
  // By brightness the rule is unknown until the first reading arrives: a manual switch is not
  // dropped on the first frame (nor at every mount of this hook) because of a missing value.
  const known = kind !== 'auto' || brightness !== null;
  useEffect(() => {
    if (manualNightExpired(preferences.nightForced, preferences.nightForcedAt, known ? auto : null)) setChatPreferences({ nightForced: null, nightForcedAt: null });
  }, [auto, known, preferences.nightForced, preferences.nightForcedAt]);
  return { night: preferences.nightForced ?? auto, auto, known };
}
