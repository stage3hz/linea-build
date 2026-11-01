export type ScreenQuality = '720p60' | '1080p60';
export const SCREEN_QUALITIES = {
  '720p60': { width: 1280, height: 720, frameRate: 60, maxBitrate: 4_000_000 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
} as const;
export function screenQuality(value: unknown): ScreenQuality {
  if (value !== '720p60' && value !== '1080p60') throw new Error('Неизвестное качество демонстрации.');
  return value;
}
export function screenControl(raw: unknown): { active: boolean; quality: ScreenQuality } | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  try { const v = JSON.parse(raw); return v.type === 'screen' && typeof v.active === 'boolean' ? { active: v.active, quality: screenQuality(v.quality) } : null; } catch { return null; }
}
