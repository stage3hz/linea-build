// Animated avatar frames drawn in code (SVG + Reanimated), no image files: sharp at any size, light, and
// smooth on iPhone and Android. Each frame sits around a round avatar of `size` and reaches 30% past it.
// `live` plays the motion (profiles, the selected choice); lists get a still frame.
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';

export type CodeFrameId = 'fx-neon' | 'fx-flame' | 'fx-stardust' | 'fx-glitch' | 'fx-aurora' | 'fx-lightning' | 'fx-hearts' | 'fx-orbit';
export const CODE_FRAMES: { id: CodeFrameId; label: string }[] = [
  { id: 'fx-neon', label: 'Неон' }, { id: 'fx-flame', label: 'Пламя' }, { id: 'fx-stardust', label: 'Звёздная пыль' },
  { id: 'fx-glitch', label: 'Глитч' }, { id: 'fx-aurora', label: 'Сияние' }, { id: 'fx-lightning', label: 'Молнии' },
  { id: 'fx-hearts', label: 'Сердца' }, { id: 'fx-orbit', label: 'Орбиты' },
];
export const isCodeFrame = (id?: string | null): id is CodeFrameId => !!id && CODE_FRAMES.some(item => item.id === id);
/** How far the frame reaches past the avatar (callers keep their layout: the frame is an overlay). */
export const CODE_FRAME_SCALE = 1.3;

function useLoop(live: boolean, duration: number, delay = 0, ease: (t: number) => number = Easing.linear) {
  const p = useSharedValue(0.15);
  useEffect(() => {
    if (!live) { cancelAnimation(p); p.value = 0.15; return; }
    p.value = 0; p.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: ease }), -1, false));
    return () => cancelAnimation(p);
  }, [live, duration, delay]);
  return p;
}
function useSpin(p: SharedValue<number>, turns = 1) { return useAnimatedStyle(() => ({ transform: [{ rotate: `${p.value * 360 * turns}deg` }] })); }
const rand = (seed: number) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };

/** A full-size layer over the frame box. */
const Layer = ({ art, style, children }: { art: number; style?: object; children: React.ReactNode }) =>
  <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: art, height: art }, style]}>{children}</Animated.View>;

function Neon({ art, live }: { art: number; live: boolean }) {
  const p = useLoop(live, 2600); const pulse = useLoop(live, 1700, 0, Easing.inOut(Easing.sin));
  const glow = useAnimatedStyle(() => ({ opacity: 0.45 + 0.4 * Math.sin(pulse.value * Math.PI) }));
  const turn = useSpin(p);
  const c = art / 2, r = art * 0.405;
  return <>
    <Layer art={art} style={glow}><Svg width={art} height={art}><Circle cx={c} cy={c} r={r} stroke="#22E4FF" strokeOpacity={0.35} strokeWidth={art * 0.07} fill="none" /></Svg></Layer>
    <Layer art={art} style={turn}><Svg width={art} height={art}>
      <Defs><LinearGradient id="neon" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#FF2BD6" /><Stop offset="0.5" stopColor="#22E4FF" /><Stop offset="1" stopColor="#7C5CFF" /></LinearGradient></Defs>
      <Circle cx={c} cy={c} r={r} stroke="url(#neon)" strokeWidth={art * 0.028} fill="none" />
      <Circle cx={c} cy={c - r} r={art * 0.022} fill="#FFFFFF" />
    </Svg></Layer>
  </>;
}

function Flame({ art, live }: { art: number; live: boolean }) {
  const c = art / 2, r = art * 0.39, count = 14;
  const tongues = useMemo(() => Array.from({ length: count }, (_, i) => i), []);
  return <>
    <Layer art={art}><Svg width={art} height={art}>
      <Defs><RadialGradient id="ember" cx="50%" cy="50%" r="50%"><Stop offset="0.72" stopColor="#FF7A1A" stopOpacity="0" /><Stop offset="0.8" stopColor="#FF7A1A" stopOpacity="0.7" /><Stop offset="1" stopColor="#FF2E00" stopOpacity="0" /></RadialGradient></Defs>
      <Circle cx={c} cy={c} r={art / 2} fill="url(#ember)" />
    </Svg></Layer>
    {tongues.map(i => <Tongue key={i} art={art} angle={(i / count) * 360} r={r} live={live} seed={i} />)}
  </>;
}
function Tongue({ art, angle, r, live, seed }: { art: number; angle: number; r: number; live: boolean; seed: number }) {
  const p = useLoop(live, 520 + rand(seed) * 380, rand(seed + 3) * 400, Easing.inOut(Easing.sin));
  const w = art * 0.08, h = art * 0.13;
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle}deg` }, { translateY: -r - h * 0.35 }, { scaleY: 0.75 + 0.45 * Math.sin(p.value * Math.PI) }, { scaleX: 0.9 + 0.15 * Math.cos(p.value * Math.PI * 2) }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: art / 2 - w / 2, top: art / 2 - h / 2, width: w, height: h }, style]}>
    <Svg width={w} height={h} viewBox="0 0 10 16"><Defs><LinearGradient id={`fl${seed}`} x1="0" y1="1" x2="0" y2="0"><Stop offset="0" stopColor="#FF3D00" /><Stop offset="0.55" stopColor="#FF9A1F" /><Stop offset="1" stopColor="#FFE680" /></LinearGradient></Defs>
      <Path d="M5 0 C7 4 10 7 10 11 C10 14 7.8 16 5 16 C2.2 16 0 14 0 11 C0 7 3 4 5 0 Z" fill={`url(#fl${seed})`} /></Svg>
  </Animated.View>;
}

function Stardust({ art, live }: { art: number; live: boolean }) {
  const slow = useLoop(live, 9000), fast = useLoop(live, 5200);
  const a = useSpin(slow), b = useSpin(fast, -1);
  const c = art / 2;
  const ring = (count: number, radius: number, seed: number, color: string) => Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + rand(seed + i) * 0.4, s = art * (0.012 + rand(seed + i * 3) * 0.018);
    return <Circle key={i} cx={c + Math.cos(angle) * radius} cy={c + Math.sin(angle) * radius} r={s} fill={color} opacity={0.55 + rand(seed + i * 7) * 0.45} />;
  });
  return <>
    <Layer art={art} style={a}><Svg width={art} height={art}>{ring(18, art * 0.42, 1, '#FFF4C2')}</Svg></Layer>
    <Layer art={art} style={b}><Svg width={art} height={art}>{ring(11, art * 0.47, 9, '#C9B8FF')}</Svg></Layer>
    {[0, 1, 2, 3].map(i => <Twinkle key={i} art={art} seed={i} live={live} />)}
  </>;
}
function Twinkle({ art, seed, live }: { art: number; seed: number; live: boolean }) {
  const p = useLoop(live, 1400 + rand(seed) * 1200, rand(seed + 5) * 1200, Easing.inOut(Easing.sin));
  const a = rand(seed + 2) * Math.PI * 2, rr = art * (0.4 + rand(seed + 4) * 0.08), s = art * 0.09;
  const style = useAnimatedStyle(() => ({ opacity: Math.sin(p.value * Math.PI), transform: [{ scale: 0.4 + Math.sin(p.value * Math.PI) * 0.8 }, { rotate: `${p.value * 90}deg` }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: art / 2 + Math.cos(a) * rr - s / 2, top: art / 2 + Math.sin(a) * rr - s / 2, width: s, height: s }, style]}>
    <Svg width={s} height={s} viewBox="0 0 10 10"><Path d="M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z" fill="#FFFFFF" /></Svg>
  </Animated.View>;
}

function useJitter(live: boolean, art: number, seed: number) {
  const x = useSharedValue(0);
  useEffect(() => {
    if (!live) { cancelAnimation(x); x.value = seed === 1 ? art * 0.012 : -art * 0.012; return; }
    const d = art * 0.025;
    x.value = withRepeat(withSequence(withTiming(0, { duration: 900 + seed * 130 }), withTiming(d * (seed % 2 ? 1 : -1), { duration: 40 }), withTiming(-d * 0.6, { duration: 50 }), withTiming(d * 0.3, { duration: 40 }), withTiming(0, { duration: 40 })), -1, false);
    return () => cancelAnimation(x);
  }, [live]);
  return useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: -x.value * 0.4 }] }));
}
function Glitch({ art, live }: { art: number; live: boolean }) {
  const c = art / 2, r = art * 0.405, w = art * 0.03;
  const red = useJitter(live, art, 1), cyan = useJitter(live, art, 2);
  return <>
    <Layer art={art} style={red}><Svg width={art} height={art}><Circle cx={c} cy={c} r={r} stroke="#FF2A55" strokeWidth={w} strokeDasharray={`${art * 0.3} ${art * 0.04}`} fill="none" opacity={0.85} /></Svg></Layer>
    <Layer art={art} style={cyan}><Svg width={art} height={art}><Circle cx={c} cy={c} r={r} stroke="#00F0FF" strokeWidth={w} strokeDasharray={`${art * 0.22} ${art * 0.06}`} fill="none" opacity={0.85} /></Svg></Layer>
    <Layer art={art}><Svg width={art} height={art}><Circle cx={c} cy={c} r={r} stroke="#FFFFFF" strokeWidth={w * 0.55} fill="none" /></Svg></Layer>
  </>;
}

function Aurora({ art, live }: { art: number; live: boolean }) {
  const a = useLoop(live, 7000), b = useLoop(live, 4800);
  const one = useSpin(a), two = useSpin(b, -1);
  const c = art / 2, r = art * 0.41;
  const ring = (id: string, colors: string[], width: number, dash?: string) => <Svg width={art} height={art}>
    <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">{colors.map((color, i) => <Stop key={i} offset={`${i / (colors.length - 1)}`} stopColor={color} />)}</LinearGradient></Defs>
    <Circle cx={c} cy={c} r={r} stroke={`url(#${id})`} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" fill="none" />
  </Svg>;
  return <>
    <Layer art={art} style={one}>{ring('au1', ['#00FFA3', '#00C2FF', '#7B61FF', '#00FFA3'], art * 0.05)}</Layer>
    <Layer art={art} style={[two, { opacity: 0.7 }]}>{ring('au2', ['#FF6AD5', '#C774E8', '#94D0FF'], art * 0.022, `${art * 0.5} ${art * 0.3}`)}</Layer>
  </>;
}

function Lightning({ art, live }: { art: number; live: boolean }) {
  const c = art / 2, r = art * 0.41;
  return <>
    <Layer art={art}><Svg width={art} height={art}><Circle cx={c} cy={c} r={r} stroke="#8FB8FF" strokeOpacity={0.55} strokeWidth={art * 0.018} fill="none" /></Svg></Layer>
    {[0, 1, 2].map(i => <Bolt key={i} art={art} seed={i} live={live} />)}
  </>;
}
function Bolt({ art, seed, live }: { art: number; seed: number; live: boolean }) {
  const flash = useSharedValue(seed === 0 ? 1 : 0); const turn = useSharedValue(rand(seed) * 360);
  useEffect(() => {
    if (!live) { cancelAnimation(flash); flash.value = seed === 0 ? 1 : 0; return; }
    const once = withSequence(withTiming(1, { duration: 60 }), withTiming(0.2, { duration: 70 }), withTiming(1, { duration: 50 }), withTiming(0, { duration: 260 }), withTiming(0, { duration: 700 + seed * 420 }));
    flash.value = withDelay(seed * 380, withRepeat(once, -1, false));
    turn.value = withRepeat(withTiming(turn.value + 360, { duration: 6000 + seed * 900, easing: Easing.linear }), -1, false);
    return () => { cancelAnimation(flash); cancelAnimation(turn); };
  }, [live]);
  const style = useAnimatedStyle(() => ({ opacity: flash.value, transform: [{ rotate: `${turn.value}deg` }] }));
  const c = art / 2, r = art * 0.41, seg = 7;
  const d = Array.from({ length: seg + 1 }, (_, i) => { const t = i / seg; const a = -0.55 + t * 1.1; const rr = r + (i % 2 ? 1 : -1) * art * 0.035; return `${i ? 'L' : 'M'}${c + Math.cos(a) * rr} ${c + Math.sin(a) * rr}`; }).join(' ');
  return <Layer art={art} style={style}><Svg width={art} height={art}><Path d={d} stroke="#6FA8FF" strokeOpacity={0.6} strokeWidth={art * 0.045} fill="none" strokeLinejoin="round" /><Path d={d} stroke="#FFFFFF" strokeWidth={art * 0.016} fill="none" strokeLinejoin="round" /></Svg></Layer>;
}

function Hearts({ art, live }: { art: number; live: boolean }) {
  const p = useLoop(live, 8000); const turn = useSpin(p);
  const c = art / 2, r = art * 0.43, count = 8;
  return <>
    <Layer art={art}><Svg width={art} height={art}><Circle cx={c} cy={c} r={art * 0.4} stroke="#FF5FA2" strokeOpacity={0.5} strokeWidth={art * 0.014} fill="none" /></Svg></Layer>
    <Layer art={art} style={turn}>{Array.from({ length: count }, (_, i) => <Heart key={i} art={art} angle={(i / count) * Math.PI * 2} r={r} seed={i} live={live} />)}</Layer>
  </>;
}
function Heart({ art, angle, r, seed, live }: { art: number; angle: number; r: number; seed: number; live: boolean }) {
  const p = useLoop(live, 1100 + rand(seed) * 500, rand(seed + 1) * 600, Easing.inOut(Easing.sin));
  const s = art * (0.07 + rand(seed + 2) * 0.03);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 0.8 + 0.3 * Math.sin(p.value * Math.PI) }] }));
  return <Animated.View style={[{ position: 'absolute', left: art / 2 + Math.cos(angle) * r - s / 2, top: art / 2 + Math.sin(angle) * r - s / 2, width: s, height: s }, style]}>
    <Svg width={s} height={s} viewBox="0 0 24 22"><Path d="M12 21.6 L10.3 20 C4.2 14.5 0.2 10.9 0.2 6.4 C0.2 2.8 3 0 6.6 0 C8.6 0 10.6 1 12 2.5 C13.4 1 15.4 0 17.4 0 C21 0 23.8 2.8 23.8 6.4 C23.8 10.9 19.8 14.5 13.7 20 Z" fill={seed % 3 ? '#FF4F8B' : '#FF9CC2'} /></Svg>
  </Animated.View>;
}

function OrbitRing({ art, live, duration, tilt, color, planet, rx }: { art: number; live: boolean; duration: number; tilt: number; color: string; planet: string; rx: number }) {
  const p = useLoop(live, duration);
  const moon = useAnimatedStyle(() => { const t = p.value * Math.PI * 2; return { transform: [{ translateX: Math.cos(t) * rx }, { translateY: Math.sin(t) * rx * 0.32 }] }; });
  const c = art / 2, s = art * 0.075;
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${tilt}deg` }] }]}>
    <Svg width={art} height={art} style={StyleSheet.absoluteFill}><Ellipse cx={c} cy={c} rx={rx} ry={rx * 0.32} stroke={color} strokeOpacity={0.7} strokeWidth={art * 0.01} fill="none" /></Svg>
    <Animated.View style={[{ position: 'absolute', left: c - s / 2, top: c - s / 2, width: s, height: s, borderRadius: s / 2, backgroundColor: planet, shadowColor: planet, shadowOpacity: 0.9, shadowRadius: s }, moon]} />
  </View>;
}
function Orbit({ art, live }: { art: number; live: boolean }) {
  return <>
    <OrbitRing art={art} live={live} duration={3600} tilt={-22} color="#9FD3FF" planet="#5EC8FF" rx={art * 0.48} />
    <OrbitRing art={art} live={live} duration={5400} tilt={28} color="#FFD39F" planet="#FFB347" rx={art * 0.46} />
  </>;
}

/** The frame art around an avatar of `size` (centred over it, reaching 30% past its edge). */
export function CodeFrame({ id, size, live }: { id: CodeFrameId; size: number; live: boolean }) {
  const art = size * CODE_FRAME_SCALE;
  const body = id === 'fx-neon' ? <Neon art={art} live={live} /> : id === 'fx-flame' ? <Flame art={art} live={live} /> : id === 'fx-stardust' ? <Stardust art={art} live={live} />
    : id === 'fx-glitch' ? <Glitch art={art} live={live} /> : id === 'fx-aurora' ? <Aurora art={art} live={live} /> : id === 'fx-lightning' ? <Lightning art={art} live={live} />
    : id === 'fx-hearts' ? <Hearts art={art} live={live} /> : <Orbit art={art} live={live} />;
  return <View pointerEvents="none" style={{ position: 'absolute', width: art, height: art, left: (size - art) / 2, top: (size - art) / 2 }}>{body}</View>;
}
