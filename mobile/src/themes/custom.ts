// «Свои цвета» (Настройки › Оформление): the user's own accent colour for the interface and their own colour for
// their message bubbles, laid over whichever theme is on (as Telegram's «Цвет акцента» / «Цвет сообщений»).
// A chosen colour is kept as the user picked it wherever it can be read; where it cannot (a pale accent on a light
// background, a light bubble under white text) it is moved just far enough toward the theme to stay legible.
import type { Theme } from '../theme';
import { contrast, mix, rgba } from './palettes.ts';

export const COLOR = /^#[0-9A-F]{6}$/;
/** A stored colour: `#RRGGBB` in upper case, or null. */
export const storedColor = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return COLOR.test(upper) ? upper : null;
};

/** The swatches offered before «Свой цвет». */
export const ACCENT_CHOICES = ['#3568E7', '#2AABEE', '#00B8A9', '#34C759', '#A3D22F', '#F5C518', '#FF9500', '#FF5E3A', '#FF3B5C', '#E64AA8', '#AF52DE', '#7B61FF'] as const;
export const BUBBLE_CHOICES = ['#2B5BD7', '#1F8FD6', '#0F8F86', '#2E9E4F', '#7A9A1F', '#B8860B', '#C96A10', '#C4472B', '#C2334F', '#B03A86', '#8640B8', '#5B48C9'] as const;

/** Hue 0…360, saturation and value 0…1 → `#RRGGBB`. */
export function hsvColor(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360, c = v * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(part => Math.round((part + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** `#RRGGBB` → hue 0…360, saturation and value 0…1. */
export function colorHsv(color: string): { h: number; s: number; v: number } {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

/** A solid `#RRGGBB` close to what a theme colour looks like (theme colours may be rgba over the background). */
function solid(color: string, fallback: string): string {
  if (COLOR.test(color.toUpperCase())) return color.toUpperCase();
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return match ? '#' + match.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase() : fallback;
}

/** `color` moved toward `toward` in small steps until it has `ratio` contrast with `against` (or 20 steps). */
function readable(color: string, against: string, toward: string, ratio: number): string {
  let result = color;
  for (let step = 1; step <= 20 && contrast(result, against) < ratio; step++) result = mix(color, toward, step / 20);
  return result;
}

/** The theme with the user's colours laid over it. Null leaves that part of the theme as it is. */
export function customTheme(theme: Theme, accentColor: string | null, bubbleColor: string | null): Theme {
  const accent = storedColor(accentColor), bubble = storedColor(bubbleColor);
  if (!accent && !bubble) return theme;
  const bg = solid(theme.bg, theme.dark ? '#101014' : '#F4F6FA'), text = solid(theme.text, theme.dark ? '#FFFFFF' : '#10141C');
  let result = theme;
  if (accent) {
    // The accent is also text (links, selected items): 3:1 against the background at least.
    const shown = readable(accent, bg, theme.dark ? '#FFFFFF' : '#000000', 3);
    const on = contrast(shown, '#FFFFFF') >= contrast(shown, '#0B0D12') ? '#FFFFFF' : '#0B0D12';
    result = { ...result, accent: shown, accentSoft: rgba(shown, theme.dark ? 0.16 : 0.12), onAccent: on, accentGradient: [mix(shown, '#FFFFFF', 0.16), mix(shown, '#000000', 0.12)] };
  }
  if (bubble) {
    // The bubble's text keeps the theme's colour: the bubble goes darker (dark themes) or paler (light ones) until
    // that text reads on it (4.5:1).
    const shown = readable(bubble, text, theme.dark ? '#000000' : '#FFFFFF', 4.5);
    result = { ...result, bubble: rgba(shown, 0.95) };
  }
  return result;
}
