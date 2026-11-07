// Telegram «Ночная тема»: when the night theme is on. The rule lives in themePreference.ts (tested);
// this hook feeds it the clock (schedule) and the screen brightness (automatic), and keeps the
// «Ночной режим» switch — a manual choice holds until the automatic rule changes by itself.
import { useEffect, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { setChatPreferences, useChatPreferences } from './chatPreferences';
import { autoNight, effectiveNightMode } from './themePreference';
import type { ThemeMode } from './types';

export function useNightState(mode: ThemeMode): { night: boolean; auto: boolean } {
  const system = useColorScheme();
  const preferences = useChatPreferences();
  const settings = { mode: preferences.nightMode, from: preferences.nightFrom, to: preferences.nightTo, brightness: preferences.nightBrightness };
  const kind = effectiveNightMode(settings, mode);
  const [now, setNow] = useState(() => new Date());
  const [brightness, setBrightness] = useState<number | null>(null);
  useEffect(() => {
    if (kind !== 'schedule' && kind !== 'auto') return;
    const tick = () => {
      setNow(new Date());
      if (kind === 'auto' && Platform.OS !== 'web') void import('expo-brightness').then(module => module.getBrightnessAsync()).then(setBrightness).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, kind === 'auto' ? 15_000 : 30_000);
    return () => clearInterval(timer);
  }, [kind]);
  const auto = autoNight(settings, mode, system, now, brightness);
  useEffect(() => {
    if (preferences.nightForced !== null && preferences.nightForcedAt !== null && auto !== preferences.nightForcedAt) setChatPreferences({ nightForced: null, nightForcedAt: null });
  }, [auto, preferences.nightForced, preferences.nightForcedAt]);
  return { night: preferences.nightForced ?? auto, auto };
}
