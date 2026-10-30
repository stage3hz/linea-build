// Pure decision: may the app animate right now? Kept free of React Native imports for tests.
export type AnimationMode = 'auto' | 'on' | 'off';
export type PowerState = { level: number | null; charging: boolean; lowPower: boolean; reduceMotion: boolean };

/** Battery level (0..1) at or below which animations switch off in automatic mode. */
export const LOW_BATTERY = 0.27;

export function motionAllowed(mode: AnimationMode, power: PowerState, threshold = LOW_BATTERY): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  if (power.reduceMotion || power.lowPower) return false;
  if (power.level !== null && power.level >= 0 && !power.charging && threshold > 0 && power.level <= threshold + 1e-9) return false;
  return true;
}

export function motionReason(mode: AnimationMode, power: PowerState, threshold = LOW_BATTERY): string {
  if (mode === 'on') return 'Анимации включены всегда.';
  if (mode === 'off') return 'Анимации выключены.';
  if (power.reduceMotion) return 'Выключены: в системе включено «Уменьшение движения».';
  if (power.lowPower) return 'Выключены: включён режим энергосбережения.';
  if (!motionAllowed(mode, power, threshold)) return `Выключены: заряд ${Math.round((power.level || 0) * 100)}% — не больше ${Math.round(threshold * 100)}%.`;
  return threshold > 0 ? `Включены. Выключатся сами при заряде ${Math.round(threshold * 100)}% и ниже или в режиме энергосбережения.` : 'Включены. По заряду не выключаются, только в режиме энергосбережения.';
}
