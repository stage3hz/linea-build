// Seven dark colour themes from the owner's palettes (6 colours each, darkest
// first). Every palette is turned into the app's full Theme by fixed roles, so
// all screens recolour consistently:
//   c0 background · c1 panels / incoming bubbles · c2 my bubbles · c3 light tone
//   c4 pale tone (text is c4 lifted toward white) · accent = c3 for the one-hue
//   palettes, or the palette's own accent colour (orange, rust, gold, pink).
import type { Theme } from '../theme';

export type PaletteId = 'amethyst' | 'coffee' | 'olive' | 'dusk' | 'lagoon' | 'indigo' | 'neon';
type Raw = { id: PaletteId; name: string; colors: [string, string, string, string, string, string]; accentIndex: 3 | 5 };

export const PALETTES: readonly Raw[] = [
  { id: 'amethyst', name: 'Аметист', colors: ['#0E0B1D', '#2A1E4D', '#5A3B8C', '#8B7CC7', '#C9C2E3', '#3A3A52'], accentIndex: 3 },
  { id: 'coffee', name: 'Кофе', colors: ['#1A120E', '#3A2418', '#6B4A2E', '#A88462', '#D5C4AE', '#4A4A46'], accentIndex: 3 },
  { id: 'olive', name: 'Олива', colors: ['#0F1F17', '#1E3A2E', '#3E5A3F', '#6B7F67', '#C7CBB8', '#3D4337'], accentIndex: 3 },
  { id: 'dusk', name: 'Сумерки', colors: ['#0B132B', '#1C2541', '#3A506B', '#5BC0DE', '#F4D6B0', '#D97706'], accentIndex: 5 },
  { id: 'lagoon', name: 'Лагуна', colors: ['#0A0F14', '#0F3D3E', '#2E6F73', '#7FB3B8', '#EADCC8', '#C6601F'], accentIndex: 5 },
  { id: 'indigo', name: 'Индиго', colors: ['#1A1A1F', '#2D2B55', '#6A5ACD', '#A678B9', '#F0D9B5', '#F4A62A'], accentIndex: 5 },
  { id: 'neon', name: 'Неон', colors: ['#121212', '#1F2937', '#334155', '#64748B', '#F1F5F9', '#EC4899'], accentIndex: 5 },
];
export const PALETTE_IDS = PALETTES.map(p => p.id) as readonly PaletteId[];
export const isPaletteId = (value: unknown): value is PaletteId => typeof value === 'string' && (PALETTE_IDS as readonly string[]).includes(value);

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const hex = (c: number[]) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
export const rgba = (color: string, alpha: number) => { const [r, g, b] = rgb(color); return `rgba(${r},${g},${b},${alpha})`; };
/** WCAG relative luminance and contrast ratio. */
export function luminance(color: string) {
  const [r, g, b] = rgb(color).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

export function paletteTheme(raw: Raw): Theme {
  const [c0, c1, c2, c3, c4] = raw.colors;
  // A muted accent (sage, tan) is lifted toward the pale tone until it reads well
  // both as text on the background and under button labels (WCAG AA, 4.5:1).
  let accent = raw.colors[raw.accentIndex];
  const onFor = (color: string) => contrast(color, c0) >= contrast(color, '#FFFFFF') ? c0 : '#FFFFFF';
  for (let step = 0; step < 20 && (contrast(accent, c0) < 4.5 || contrast(onFor(accent), accent) < 4.5); step++) accent = mix(accent, c4, 0.08);
  const text = mix(c4, '#FFFFFF', 0.55);
  const muted = mix(c4, c0, 0.32);
  const onAccent = onFor(accent);
  return {
    dark: true, black: false, bg: c0,
    surface: rgba(c1, 0.92), surface2: rgba(c2, 0.38), text, muted,
    border: rgba(c3, 0.22), accent, accentSoft: rgba(accent, 0.17), onAccent,
    bubble: rgba(mix(c2, c1, 0.15), 0.94), incoming: rgba(c1, 0.94),
    danger: '#FF8FA3', dangerBg: 'rgba(84,28,42,0.9)', chatBg: 'transparent',
    subtle: mix(c3, c0, 0.35), shadow: c0,
    glass: rgba(c1, 0.55), glassClear: rgba(c1, 0.22), glassBorder: rgba(c4, 0.2),
    glassHighlight: rgba(c4, 0.16), glassTint: rgba(c2, 0.12), glassOpaque: mix(c1, c0, 0.35),
    bgGradient: [mix(c0, c1, 0.4), c0, mix(c0, c1, 0.22)],
    ambientBlue: rgba(c2, 0.26), ambientLilac: rgba(accent, 0.12),
    accentGradient: [mix(accent, '#FFFFFF', 0.18), accent],
  };
}

export const paletteThemes = Object.fromEntries(PALETTES.map(raw => [raw.id, paletteTheme(raw)])) as Record<PaletteId, Theme>;
