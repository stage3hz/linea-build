// «Свои цвета» (Настройки › Оформление): the accent colour of the interface and the colour of your own messages,
// over whichever theme is on. A row of swatches, «Свой цвет» with three sliders, and «Как в теме» to go back.
// The choice applies at once to the whole app — that is the preview; the sample messages in the sheet show the chat.
// The rules for the colours are in themes/custom.ts.
import React, { useState } from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from './typography';
import { Icon, Sheet } from './components';
import { useTheme } from './theme';
import { setChatPreferences, useChatPreferences } from './chatPreferences';
import { ACCENT_CHOICES, BUBBLE_CHOICES, colorHsv, hsvColor } from './themes/custom';

type Part = 'accent' | 'bubble';
const TITLES: Record<Part, string> = { accent: 'Цвет интерфейса', bubble: 'Цвет своих сообщений' };
const HUES = ['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FF0000'] as const;

/** A slider drawn as a gradient: touch or drag anywhere along it. `value` and the result are 0…1. */
function Strip({ colors, value, label, onChange }: { colors: readonly [string, string, ...string[]]; value: number; label: string; onChange: (value: number) => void }) {
  const [width, setWidth] = useState(0);
  const at = (event: GestureResponderEvent) => { if (width > 0) onChange(Math.min(1, Math.max(0, event.nativeEvent.locationX / width))); };
  return <View accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    onLayout={event => setWidth(event.nativeEvent.layout.width)}
    onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
    onResponderGrant={at} onResponderMove={at}
    style={{ height: 34, justifyContent: 'center' }}>
    <LinearGradient pointerEvents="none" colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ height: 14, borderRadius: 7 }} />
    <View pointerEvents="none" style={{ position: 'absolute', left: Math.max(0, Math.min(width - 26, value * width - 13)), width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: 'rgba(0,0,0,0.35)' }} />
  </View>;
}

export function ColorSettings() {
  const t = useTheme(); const preferences = useChatPreferences();
  const [open, setOpen] = useState<Part | null>(null);
  const [custom, setCustom] = useState(false);
  // The sliders' own position: a grey or a black has no hue of its own, and the hue slider must not jump back.
  const [sliders, setSliders] = useState<{ h: number; s: number; v: number } | null>(null);
  const chosen = (part: Part) => (part === 'accent' ? preferences.accentColor : preferences.bubbleColor);
  const set = (part: Part, color: string | null) => setChatPreferences(part === 'accent' ? { accentColor: color } : { bubbleColor: color });
  const row = (part: Part, last: boolean) => <Pressable accessibilityRole="button" accessibilityLabel={TITLES[part]} onPress={() => { setCustom(false); setOpen(part); }}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 14, backgroundColor: pressed ? t.surface2 : 'transparent', borderBottomWidth: last ? 0 : 1, borderBottomColor: t.border })}>
    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: part === 'accent' ? t.accent : t.bubble, borderWidth: 1, borderColor: t.border }} />
    <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>{TITLES[part]}</Text>
    <Text style={{ color: t.muted, fontSize: 14 }}>{chosen(part) ? 'Свой' : 'Как в теме'}</Text>
    <Icon name="chevron-forward" size={16} color={t.muted} />
  </Pressable>;
  const part = open;
  const current = part ? chosen(part) : null;
  // The sliders start from the colour in use (the theme's own when nothing is chosen).
  const base = current || (part === 'bubble' ? BUBBLE_CHOICES[0] : ACCENT_CHOICES[0]);
  const hsv = custom && sliders ? sliders : colorHsv(base);
  const move = (change: Partial<{ h: number; s: number; v: number }>) => { if (!part) return; const next = { ...hsv, ...change }; setSliders(next); set(part, hsvColor(next.h, next.s, next.v)); };
  const choices = part === 'bubble' ? BUBBLE_CHOICES : ACCENT_CHOICES;
  return <>
    {row('accent', false)}
    {row('bubble', true)}
    <Sheet visible={!!part} title={part ? TITLES[part] : ''} onClose={() => setOpen(null)}>
      {part ? <View style={{ gap: 16, paddingBottom: 6 }}>
        {/* How it looks in a chat, in the colours that are on right now. */}
        <View style={{ gap: 6, padding: 12, borderRadius: 18, backgroundColor: t.chatBg, borderWidth: 1, borderColor: t.border }}>
          <View style={{ alignSelf: 'flex-start', maxWidth: '78%', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: t.incoming }}><Text style={{ color: t.text, fontSize: 15 }}>Как тебе новый цвет?</Text></View>
          <View style={{ alignSelf: 'flex-end', maxWidth: '78%', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: t.bubble }}><Text style={{ color: t.text, fontSize: 15 }}>Нравится, оставляю</Text><Text style={{ color: t.accent, fontSize: 13, marginTop: 2 }}>ссылка · 12:30 ✓✓</Text></View>
          <View style={{ alignSelf: 'center', marginTop: 4, paddingHorizontal: 18, height: 36, borderRadius: 18, justifyContent: 'center', backgroundColor: t.accent }}><Text style={{ color: t.onAccent, fontSize: 14, fontWeight: '700' }}>Кнопка</Text></View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
          {choices.map(color => { const on = current === color; return <Pressable key={color} accessibilityRole="radio" accessibilityLabel={`Цвет ${color}`} accessibilityState={{ selected: on }} onPress={() => { setCustom(false); set(part, color); }}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color, alignItems: 'center', justifyContent: 'center', borderWidth: on ? 3 : 0, borderColor: t.text }}>{on ? <Icon name="checkmark" size={20} color="#FFFFFF" /> : null}</Pressable>; })}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={() => { setCustom(false); set(part, null); }} style={{ flex: 1, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: current ? t.surface2 : t.accentSoft, borderWidth: 1, borderColor: current ? t.border : t.accent }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Как в теме</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: custom }} onPress={() => { setSliders(colorHsv(base)); setCustom(value => !value); if (!current) set(part, base); }} style={{ flex: 1, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: custom ? t.accentSoft : t.surface2, borderWidth: 1, borderColor: custom ? t.accent : t.border }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Свой цвет</Text></Pressable>
        </View>
        {custom ? <View style={{ gap: 6 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>Оттенок</Text>
          <Strip label="Оттенок" colors={HUES} value={hsv.h / 360} onChange={value => move({ h: Math.min(359.9, value * 360) })} />
          <Text style={{ color: t.muted, fontSize: 12 }}>Насыщенность</Text>
          <Strip label="Насыщенность" colors={[hsvColor(hsv.h, 0, hsv.v), hsvColor(hsv.h, 1, hsv.v)]} value={hsv.s} onChange={value => move({ s: value })} />
          <Text style={{ color: t.muted, fontSize: 12 }}>Яркость</Text>
          <Strip label="Яркость" colors={['#000000', hsvColor(hsv.h, hsv.s, 1)]} value={hsv.v} onChange={value => move({ v: Math.max(0.12, value) })} />
          <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>{current || base}</Text>
        </View> : null}
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым.</Text>
      </View> : null}
    </Sheet>
  </>;
}
