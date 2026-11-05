// Discord-style nameplates: a picture that fills the whole row behind a person's name in the chat list
// and member lists, fading into the row on the left so the name and preview stay readable.
// All artwork is drawn here (vector, deterministic) — no third-party images.
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, Ellipse, G, Path, Rect, Stop, LinearGradient as SvgGradient } from 'react-native-svg';

export const NAMEPLATES: { id: string; label: string; colors: [string, string] }[] = [
  { id: 'crows', label: 'Вороны', colors: ['#2B2F36', '#69717E'] },
  { id: 'leopard', label: 'Барс', colors: ['#3A3A3E', '#A4A4AA'] },
  { id: 'sparkle', label: 'Блеск', colors: ['#0B0B12', '#3E3858'] },
  { id: 'deep', label: 'Глубина', colors: ['#06122E', '#1D4596'] },
  { id: 'aurora', label: 'Сияние', colors: ['#040A16', '#0E2A3A'] },
  { id: 'ember', label: 'Пламя', colors: ['#1A0603', '#5E1606'] },
  { id: 'night', label: 'Ночь', colors: ['#070616', '#2A1C66'] },
  { id: 'sakura', label: 'Сакура', colors: ['#24091A', '#6E2249'] },
  { id: 'mint', label: 'Мята', colors: ['#03201A', '#0F5C46'] },
  { id: 'platinum', label: 'Платина', colors: ['#22262E', '#8E97A8'] },
];

const W = 400, H = 84;
// Small deterministic generator: the same plate looks the same on every device.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function Art({ id }: { id: string }) {
  const r = useMemo(() => rng(id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), [id]);
  switch (id) {
    case 'crows': return <G>{Array.from({ length: 14 }, (_, i) => { const x = 120 + r() * 270, y = 8 + r() * 66, s = 4 + r() * 9;
      return <Path key={i} d={`M${x - s} ${y - s * .25} Q${x - s * .45} ${y - s * .55} ${x} ${y} Q${x + s * .45} ${y - s * .55} ${x + s} ${y - s * .25} Q${x + s * .45} ${y - s * .2} ${x} ${y + s * .22} Q${x - s * .45} ${y - s * .2} ${x - s} ${y - s * .25}Z`} fill="#0B0C10" opacity={.55 + r() * .4} />; })}</G>;
    case 'leopard': return <G>{Array.from({ length: 34 }, (_, i) => { const x = 90 + r() * 320, y = r() * H, s = 4 + r() * 6;
      return <G key={i}><Ellipse cx={x} cy={y} rx={s * 1.25} ry={s} fill="none" stroke="#1E1E22" strokeWidth={s * .55} strokeDasharray={`${s * 1.4} ${s * .6}`} opacity={.8} /><Ellipse cx={x} cy={y} rx={s * .55} ry={s * .42} fill="#6E6A60" opacity={.55} /></G>; })}</G>;
    case 'sparkle': return <G>{Array.from({ length: 16 }, (_, i) => { const x = 110 + r() * 285, y = 6 + r() * 72, s = 2 + r() * 7;
      return <Path key={i} d={`M${x} ${y - s * 2}Q${x + s * .25} ${y - s * .25} ${x + s * 2} ${y}Q${x + s * .25} ${y + s * .25} ${x} ${y + s * 2}Q${x - s * .25} ${y + s * .25} ${x - s * 2} ${y}Q${x - s * .25} ${y - s * .25} ${x} ${y - s * 2}Z`} fill="#FFFFFF" opacity={.5 + r() * .5} />; })}</G>;
    case 'deep': return <G>{[0, 1, 2, 3].map(i => <Path key={i} d={`M0 ${30 + i * 14} C100 ${18 + i * 14} 200 ${44 + i * 14} 300 ${28 + i * 14} S400 ${36 + i * 14} 420 ${30 + i * 14} V90 H0Z`} fill="#4F8CFF" opacity={.12 + i * .05} />)}
      {Array.from({ length: 10 }, (_, i) => <Circle key={i} cx={200 + r() * 200} cy={r() * H} r={1.5 + r() * 3.5} fill="none" stroke="#BFD8FF" strokeWidth={1} opacity={.6} />)}</G>;
    case 'aurora': return <G>{[['#2EE6C8', 0], ['#7B5CFF', 16], ['#36A8FF', 30]].map(([c, o], i) =>
      <Path key={i} d={`M120 ${70 - Number(o)} C200 ${10 - Number(o) / 2} 260 ${80 - Number(o)} 330 ${20} S400 ${40 - Number(o) / 2} 420 ${10}`} stroke={String(c)} strokeWidth={18 - i * 4} strokeLinecap="round" fill="none" opacity={.38} />)}
      {Array.from({ length: 12 }, (_, i) => <Circle key={i} cx={r() * W} cy={r() * 40} r={.8 + r()} fill="#FFFFFF" opacity={.7} />)}</G>;
    case 'ember': return <G>{Array.from({ length: 9 }, (_, i) => { const x = 150 + i * 30 + r() * 10, h = 30 + r() * 40;
      return <Path key={i} d={`M${x - 16} ${H} C${x - 18} ${H - h * .5} ${x - 2} ${H - h * .6} ${x} ${H - h} C${x + 4} ${H - h * .55} ${x + 18} ${H - h * .45} ${x + 16} ${H}Z`} fill={i % 2 ? '#FF7A2E' : '#FF3D1F'} opacity={.55} />; })}
      {Array.from({ length: 14 }, (_, i) => <Circle key={i} cx={160 + r() * 240} cy={r() * 50} r={1 + r() * 1.8} fill="#FFC36B" opacity={.85} />)}</G>;
    case 'night': return <G>{Array.from({ length: 26 }, (_, i) => <Circle key={i} cx={r() * W} cy={r() * H} r={.6 + r() * 1.5} fill="#FFFFFF" opacity={.4 + r() * .6} />)}
      <Circle cx={352} cy={38} r={22} fill="#F3E9C6" opacity={.9} /><Circle cx={364} cy={31} r={20} fill="#2A1C66" /></G>;
    case 'sakura': return <G>{Array.from({ length: 18 }, (_, i) => { const x = 120 + r() * 280, y = r() * H, s = 3 + r() * 4, a = r() * 180;
      return <Ellipse key={i} cx={x} cy={y} rx={s * 1.6} ry={s} fill={i % 3 ? '#FFB3CC' : '#FFD6E4'} opacity={.75} transform={`rotate(${a} ${x} ${y})`} />; })}</G>;
    case 'mint': return <G>{Array.from({ length: 12 }, (_, i) => { const x = 140 + r() * 260, y = r() * H, s = 6 + r() * 8, a = r() * 180;
      return <Path key={i} d={`M${x - s} ${y} Q${x} ${y - s * .8} ${x + s} ${y} Q${x} ${y + s * .8} ${x - s} ${y}Z`} fill="#5BE3A6" opacity={.4} transform={`rotate(${a} ${x} ${y})`} />; })}</G>;
    case 'platinum': return <G>{Array.from({ length: 7 }, (_, i) => <Rect key={i} x={150 + i * 40} y={-40} width={6 + (i % 3) * 5} height={170} fill="#FFFFFF" opacity={.08 + (i % 2) * .08} transform={`rotate(25 ${150 + i * 40} 40)`} />)}</G>;
    default: return null;
  }
}

/**
 * The plate itself: fills its parent (absolute). `radius` rounds it like Discord's highlighted row.
 * `compact` drops the readability fade (used for small previews in the picker).
 */
export function Nameplate({ plate, radius = 0, compact = false }: { plate?: string | null; radius?: number; compact?: boolean }) {
  const item = NAMEPLATES.find(entry => entry.id === plate);
  if (!item) return null;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)' }]}>
    <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMaxYMid slice">
      <Defs><SvgGradient id={`np-${item.id}`} x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor={item.colors[0]} /><Stop offset="1" stopColor={item.colors[1]} /></SvgGradient></Defs>
      <Rect x={0} y={0} width={W} height={H} fill={`url(#np-${item.id})`} />
      <Art id={item.id} />
    </Svg>
    {compact ? null : <LinearGradient colors={['rgba(0,0,0,0.62)', 'rgba(0,0,0,0.32)', 'rgba(0,0,0,0.05)']} locations={[0, .5, 1]} start={{ x: 0, y: .5 }} end={{ x: 1, y: .5 }} style={StyleSheet.absoluteFill} />}
  </View>;
}
