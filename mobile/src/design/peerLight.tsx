// The light of the person you are talking to: a soft glow in their own colour on their side of the screen
// (the left, where their words are), and a faint white one on yours. One static vector picture: no blur,
// no animation, nothing redrawn while the list scrolls. It is transparent: the page behind it (with the
// pixel trail and the snow) stays visible.
import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '../theme';

const HEX = /^#[0-9a-f]{6}$/i;
/** A person's colour as given by the server, or the theme's accent when it is missing or malformed. */
export function peerTint(color: string | null | undefined, fallback: string): string {
  return color && HEX.test(color) ? color : fallback;
}

/**
 * Lifts a dark avatar colour to something readable as a thin line or a status text on a dark page: the hue is
 * kept, each channel is moved towards white until the brightest one reaches `floor`.
 */
export function brightTint(color: string, floor = 190): string {
  if (!HEX.test(color)) return color;
  const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));
  const top = Math.max(...rgb);
  if (top >= floor) return color;
  const lift = (floor - top) / (255 - top || 1);
  return '#' + rgb.map(value => Math.round(value + (255 - value) * lift).toString(16).padStart(2, '0')).join('');
}

/**
 * The three colours of an avatar without a photo: the person's own colour in the middle, a lighter neighbour
 * hue at one corner and a deeper one at the other, so the circle reads as a lit ball and not a flat disc.
 */
export function orbColors(color: string): [string, string, string] {
  if (!HEX.test(color)) return [color, color, color];
  const [r, g, b] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const hue = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  const hsl = (h: number, s: number, light: number) => {
    const a = s * Math.min(light, 1 - light);
    const part = (n: number) => { const k = (n + ((h % 360) + 360) % 360 / 30) % 12; return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
    return '#' + part(0) + part(8) + part(4);
  };
  const s = Math.min(1, sat * 1.15 + 0.08);
  return [hsl(hue + 38, s, Math.min(0.72, l + 0.16)), hsl(hue, s, l), hsl(hue - 34, s, Math.max(0.22, l - 0.14))];
}

export const PeerLight = memo(function PeerLight({ color, style }: { color: string; style?: object }) {
  const t = useTheme();
  const glow = brightTint(color, 150);
  // On a light page the glow is a tint, on a dark one it is light.
  const near = t.dark ? 0.46 : 0.18, far = t.dark ? 0.14 : 0.06;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <RadialGradient id="peer" cx="-12%" cy="32%" rx="78%" ry="46%" gradientUnits="objectBoundingBox">
          <Stop offset="0" stopColor={glow} stopOpacity={near} />
          <Stop offset="0.55" stopColor={glow} stopOpacity={far} />
          <Stop offset="1" stopColor={glow} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="mine" cx="112%" cy="80%" rx="62%" ry="34%" gradientUnits="objectBoundingBox">
          <Stop offset="0" stopColor={t.dark ? '#FFFFFF' : t.accent} stopOpacity={t.dark ? 0.09 : 0.07} />
          <Stop offset="1" stopColor={t.dark ? '#FFFFFF' : t.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#peer)" />
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#mine)" />
    </Svg>
  </View>;
});

/**
 * The same light at the top of a person's profile when they have no banner: it falls from above, behind the
 * avatar, and fades into the page.
 */
export const ProfileLight = memo(function ProfileLight({ color, height = 440 }: { color: string; height?: number }) {
  const t = useTheme();
  const glow = brightTint(color, 150);
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height }}>
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <RadialGradient id="profile" cx="50%" cy="6%" rx="92%" ry="88%" gradientUnits="objectBoundingBox">
          <Stop offset="0" stopColor={glow} stopOpacity={t.dark ? 0.5 : 0.22} />
          <Stop offset="0.5" stopColor={glow} stopOpacity={t.dark ? 0.16 : 0.08} />
          <Stop offset="1" stopColor={glow} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#profile)" />
    </Svg>
  </View>;
});
