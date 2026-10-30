// Equalizer settings (pure: unit-tested). One profile for every output — speaker, wired and
// Bluetooth headphones: «Рекомендованный» (flat) or «Пользовательский» with НЧ / СЧ / ВЧ gains in dB.
export type EqProfile = { mode: 'recommended' | 'custom'; low: number; mid: number; high: number };
export type EqSettings = EqProfile;
export const EQ_LIMIT = 12;
export const EQ_BANDS = [{ key: 'low', label: 'НЧ', hz: 120 }, { key: 'mid', label: 'СЧ', hz: 1000 }, { key: 'high', label: 'ВЧ', hz: 8000 }] as const;
export const FLAT: EqProfile = { mode: 'recommended', low: 0, mid: 0, high: 0 };
export const DEFAULT_EQ: EqSettings = FLAT;

const gain = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(-EQ_LIMIT, Math.min(EQ_LIMIT, value)) * 2) / 2 : 0;
export function parseEq(raw: string | null): EqSettings {
  try {
    const value = raw ? JSON.parse(raw) : null;
    const profile = (item: any): EqProfile => ({ mode: item?.mode === 'custom' ? 'custom' : 'recommended', low: gain(item?.low), mid: gain(item?.mid), high: gain(item?.high) });
    // Earlier builds kept separate headphone/speaker profiles: keep the headphone one.
    return profile(value && typeof value === 'object' && 'headphones' in value ? value.headphones : value);
  } catch { return DEFAULT_EQ; }
}
/** What the audio engine applies: the custom gains, or flat (bypass) for «Рекомендованный». */
export function effectiveGains(profile: EqProfile): { low: number; mid: number; high: number; enabled: boolean } {
  if (profile.mode !== 'custom') return { low: 0, mid: 0, high: 0, enabled: false };
  return { low: profile.low, mid: profile.mid, high: profile.high, enabled: profile.low !== 0 || profile.mid !== 0 || profile.high !== 0 };
}
