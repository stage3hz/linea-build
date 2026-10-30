import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../typography';
import { Icon, IconButton } from '../components';
import { useTheme } from '../theme';
import { lightFeedback } from '../haptics';
import { useMusic } from './MusicProvider';
import { TrackArtwork } from './PlayerControls';
import { equalizerAvailable, setEqProfile, useEqualizer } from './equalizer';
import { EQ_BANDS, EQ_LIMIT, type EqProfile, type EqRoute } from './equalizerModel';

type Key = 'low' | 'mid' | 'high';

/**
 * Equalizer in the layout of the AirPods settings: «Рекомендованный / Пользовательский», the
 * playing track with ▶ to listen while adjusting, a curve with three points (НЧ, СЧ, ВЧ) that
 * are dragged up and down, «Сбросить». Separate settings for headphones and the phone speaker.
 */
export function EqualizerScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const music = useMusic(); const { settings, route } = useEqualizer();
  const [editing, setEditing] = useState<EqRoute>(route.route);
  useEffect(() => { if (visible) setEditing(route.route); }, [visible, route.route]);
  const profile = settings[editing];
  const card = t.dark ? '#1C1C1E' : '#FFFFFF';
  const update = (change: Partial<EqProfile>) => setEqProfile(editing, { ...profile, ...change });
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.dark ? '#000' : '#F2F2F7' }}>
      <View style={{ paddingTop: insets.top + 6, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: insets.top + 60 }}>
        <IconButton name="chevron-back" label="Назад" onPress={onClose} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '600', marginRight: 44 }}>Эквалайзер</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 14 }}>
        <View style={{ flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: t.dark ? '#1C1C1E' : '#E3E3E8' }}>
          {(['headphones', 'speaker'] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: editing === item }} onPress={() => setEditing(item)} style={{ flex: 1, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, backgroundColor: editing === item ? (t.dark ? '#3A3A3C' : '#FFFFFF') : 'transparent' }}>
            <Icon name={item === 'headphones' ? 'headset-outline' : 'phone-portrait-outline'} size={15} color={t.text} />
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{item === 'headphones' ? 'Наушники' : 'Динамик'}</Text>
            {route.route === item ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#34C759' }} /> : null}
          </Pressable>)}
        </View>
        <Text style={{ color: t.muted, fontSize: 13, paddingHorizontal: 4, marginTop: -6 }}>{route.route === 'headphones' ? `Сейчас: ${route.name || 'наушники'}` : 'Сейчас: динамик телефона'} · профиль включается сам</Text>
        <View style={{ borderRadius: 22, backgroundColor: card, overflow: 'hidden' }}>
          {(['recommended', 'custom'] as const).map((mode, index) => <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ selected: profile.mode === mode }} onPress={() => update({ mode })} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 18, borderTopWidth: index ? 0.5 : 0, borderTopColor: t.border, backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
            <Text style={{ flex: 1, color: t.text, fontSize: 17 }}>{mode === 'recommended' ? 'Рекомендованный' : 'Пользовательский'}</Text>
            {profile.mode === mode ? <Icon name="checkmark" size={22} color="#0A84FF" /> : null}
          </Pressable>)}
        </View>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18, paddingHorizontal: 4 }}>«Рекомендованный» — звук трека без изменений. В «Пользовательском» потяни точки НЧ, СЧ и ВЧ вверх или вниз: настройки отдельные для наушников и для динамика.</Text>
        <View style={{ borderRadius: 22, backgroundColor: card, padding: 18, gap: 16, opacity: profile.mode === 'custom' ? 1 : 0.5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {music.current ? <TrackArtwork track={music.current} size={64} /> : <View style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: t.dark ? '#2C2C2E' : '#E5E5EA' }} />}
            <View style={{ flex: 1 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{music.current?.title || 'Включи трек'}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>{music.current?.artist || 'чтобы слышать изменения'}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel={music.playing ? 'Пауза' : 'Слушать'} disabled={!music.current} onPress={() => void music.togglePlayback()} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.dark ? '#2C2C2E' : '#E5E5EA', alignItems: 'center', justifyContent: 'center', opacity: music.current ? 1 : .5 }}><Icon name={music.playing ? 'pause' : 'play'} size={24} color={t.text} /></Pressable>
          </View>
          <View style={{ height: 0.5, backgroundColor: t.border }} />
          <Curve width={width - 68} profile={profile} disabled={profile.mode !== 'custom'} onChange={(key, value) => update({ [key]: value })} />
        </View>
        <Pressable accessibilityRole="button" onPress={() => { lightFeedback(); update({ low: 0, mid: 0, high: 0 }); }} style={({ pressed }) => ({ height: 54, borderRadius: 27, backgroundColor: card, alignItems: 'center', justifyContent: 'center', opacity: pressed ? .6 : 1 })}><Text style={{ color: '#0A84FF', fontSize: 17 }}>Сбросить</Text></Pressable>
        {!equalizerAvailable ? <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>Эквалайзер заработает в новой сборке приложения.</Text> : null}
      </ScrollView>
    </GestureHandlerRootView>
  </Modal>;
}

/** The curve: flat ends, smooth S-shapes through three draggable points, dotted zero line. */
function Curve({ width, profile, disabled, onChange }: { width: number; profile: EqProfile; disabled: boolean; onChange: (key: Key, value: number) => void }) {
  const t = useTheme(); const height = 250, pad = 28, labels = 34;
  const xs = [width * 0.17, width * 0.5, width * 0.83];
  const yOf = (db: number) => pad + (EQ_LIMIT - db) / (2 * EQ_LIMIT) * (height - 2 * pad);
  const dbOf = (y: number) => Math.round(Math.max(-EQ_LIMIT, Math.min(EQ_LIMIT, EQ_LIMIT - (y - pad) / (height - 2 * pad) * 2 * EQ_LIMIT)) * 2) / 2;
  const values = [profile.low, profile.mid, profile.high];
  const ys = values.map(yOf);
  const mid = (a: number, b: number) => (a + b) / 2;
  const path = `M0 ${ys[0]} L${xs[0]} ${ys[0]} C${mid(xs[0], xs[1])} ${ys[0]} ${mid(xs[0], xs[1])} ${ys[1]} ${xs[1]} ${ys[1]} C${mid(xs[1], xs[2])} ${ys[1]} ${mid(xs[1], xs[2])} ${ys[2]} ${xs[2]} ${ys[2]} L${width} ${ys[2]}`;
  const colour = (db: number) => db > 0.5 ? '#FFE15A' : db < -0.5 ? '#5AD8FF' : '#9BE87A';
  const [active, setActive] = useState<number | null>(null);
  const startY = useRef(0); const last = useRef(values); last.current = values;
  const begin = (index: number) => { setActive(index); startY.current = yOf(last.current[index]); lightFeedback(); };
  const move = (index: number, dy: number) => { const value = dbOf(startY.current + dy); if (value !== last.current[index]) onChange(EQ_BANDS[index].key, value); };
  const gesture = (index: number) => Gesture.Pan().enabled(!disabled).hitSlop({ left: 30, right: 30, top: 40, bottom: 40 })
    .onBegin(() => runOnJS(begin)(index)).onUpdate(event => runOnJS(move)(index, event.translationY)).onFinalize(() => runOnJS(setActive)(null));
  return <View style={{ width, height: height + labels }}>
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="eqline" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#FFE15A" /><Stop offset="0.5" stopColor="#9BE87A" /><Stop offset="1" stopColor="#5AD8FF" /></LinearGradient>
        <LinearGradient id="eqfocus" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={t.dark ? '#FFFFFF' : '#000000'} stopOpacity={0} /><Stop offset="0.5" stopColor={t.dark ? '#FFFFFF' : '#000000'} stopOpacity={0.08} /><Stop offset="1" stopColor={t.dark ? '#FFFFFF' : '#000000'} stopOpacity={0} /></LinearGradient>
      </Defs>
      {active !== null ? <Rect x={xs[active] - width * 0.165} y={0} width={width * 0.33} height={height} fill="url(#eqfocus)" /> : null}
      {xs.map(x => <Line key={x} x1={x} y1={8} x2={x} y2={height - 8} stroke={t.muted} strokeOpacity={0.5} strokeDasharray="4 5" strokeWidth={1} />)}
      <Line x1={0} y1={yOf(0)} x2={width} y2={yOf(0)} stroke="#0A84FF" strokeWidth={3} strokeDasharray="0.1 7" strokeLinecap="round" />
      <Path d={path} stroke="url(#eqline)" strokeWidth={5} fill="none" strokeLinecap="round" />
      {xs.map((x, index) => <Circle key={index} cx={x} cy={ys[index]} r={active === index ? 15 : 13} fill={colour(values[index])} />)}
    </Svg>
    {xs.map((x, index) => <GestureDetector key={index} gesture={gesture(index)}><View accessible accessibilityRole="adjustable" accessibilityLabel={`${EQ_BANDS[index].label}: ${values[index]} дБ`}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={event => onChange(EQ_BANDS[index].key, Math.max(-EQ_LIMIT, Math.min(EQ_LIMIT, values[index] + (event.nativeEvent.actionName === 'increment' ? 1 : -1))))}
      style={{ position: 'absolute', left: x - 30, top: 0, width: 60, height }} /></GestureDetector>)}
    <View style={{ flexDirection: 'row', height: labels }}>{xs.map((x, index) => <View key={index} style={{ position: 'absolute', left: x - 40, width: 80, alignItems: 'center', top: 6 }}>
      <Text style={{ color: active === index ? t.text : t.muted, fontSize: 19, fontWeight: '700' }}>{active === index ? `${values[index] > 0 ? '+' : ''}${values[index]} дБ` : EQ_BANDS[index].label}</Text>
    </View>)}</View>
  </View>;
}
