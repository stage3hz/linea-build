// PC: the first launch after installing or updating Инвиз. The Windows installer itself is a quick
// one-click step (no wizard pages); the welcome happens here, in the app's own colours (solid
// theme colours, no gradients) with calm motion: the logo settles in, a ring draws around it,
// then what is new appears line by line. Shown once per version; Enter / «Начать» closes it.
import React, { useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeOut, useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Text } from './typography';
import { Icon, type IconName } from './components';
import { useTheme } from './theme';
import { APP_VERSION } from './serverConfig';
import { TITLE_BAR_HEIGHT } from './TitleBar';

const KEY = 'invizent.welcome.version';
const NEWS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'browsers-outline', title: 'Окно как в Windows', text: 'Свернуть, развернуть и закрыть — справа. Закрытие оставляет Инвиз в трее.' },
  { icon: 'person-circle-outline', title: 'Профиль как в Telegram', text: 'Имя — быстрые действия, аватар — полный профиль с фото и видео.' },
  { icon: 'mic-outline', title: 'Голосовые и кружки', text: 'Удерживай кнопку: влево — отмена, вверх — без рук.' },
  { icon: 'images-outline', title: 'Фото с превью', text: 'Миниатюры у фото, видео и GIF, редактор перед отправкой.' },
  { icon: 'search-outline', title: 'Поиск по сообщениям', text: 'Находит слова в чатах и в Избранном.' },
];
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function read(): string | null { try { return globalThis.localStorage?.getItem(KEY) ?? null; } catch { return null; } }
function write() { try { globalThis.localStorage?.setItem(KEY, APP_VERSION); } catch { /* private storage off */ } }

export function DesktopWelcome() {
  const t = useTheme();
  const [state, setState] = useState<'hidden' | 'installed' | 'updated'>('hidden');
  useEffect(() => {
    if (Platform.OS !== 'web' || !(globalThis as { invizentDesktop?: unknown }).invizentDesktop) return;
    const seen = read(); if (seen === APP_VERSION) return;
    setState(seen ? 'updated' : 'installed');
  }, []);
  const close = () => { write(); setState('hidden'); };
  useEffect(() => {
    if (state === 'hidden' || typeof window === 'undefined') return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === 'Escape') close(); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [state]);

  const logo = useSharedValue(0), ring = useSharedValue(0), pulse = useSharedValue(1);
  useEffect(() => {
    if (state === 'hidden') return;
    logo.value = withSpring(1, { damping: 14, stiffness: 120 });
    ring.value = withDelay(250, withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }));
    pulse.value = withDelay(1200, withRepeat(withSequence(withTiming(1.04, { duration: 1400 }), withTiming(1, { duration: 1400 })), -1));
  }, [state]);
  const logoStyle = useAnimatedStyle(() => ({ opacity: logo.value, transform: [{ scale: (0.7 + logo.value * 0.3) * pulse.value }] }));
  const R = 62, C = 2 * Math.PI * R;
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: C * (1 - ring.value) }));

  if (state === 'hidden') return null;
  return <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(200)} style={[StyleSheet.absoluteFill, { top: TITLE_BAR_HEIGHT, zIndex: 5000, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
    <View style={{ width: '100%', maxWidth: 520, alignItems: 'center', gap: 22 }}>
      <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={140} height={140} style={StyleSheet.absoluteFill}>
          <Circle cx={70} cy={70} r={R} stroke={t.border} strokeWidth={2} fill="none" />
          <AnimatedCircle cx={70} cy={70} r={R} stroke={t.accent} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={`${C} ${C}`} animatedProps={ringProps} transform="rotate(-90 70 70)" />
        </Svg>
        <Animated.View style={[{ width: 96, height: 96, borderRadius: 26, overflow: 'hidden', backgroundColor: t.surface2 }, logoStyle]}>
          <Image source={require('../assets/icons/outline.png')} style={{ width: 96, height: 96 }} resizeMode="cover" />
        </Animated.View>
      </View>
      <Animated.View entering={FadeInDown.delay(500).duration(400)} style={{ alignItems: 'center', gap: 6 }}>
        <Text style={{ color: t.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.6 }}>{state === 'installed' ? 'Инвиз установлен' : 'Инвиз обновлён'}</Text>
        <Text style={{ color: t.muted, fontSize: 14 }}>Версия {APP_VERSION} · сквозное шифрование включено</Text>
      </Animated.View>
      <View style={{ alignSelf: 'stretch', gap: 8 }}>
        {NEWS.map((item, index) => <Animated.View key={item.title} entering={FadeInDown.delay(750 + index * 110).duration(380)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 16, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={item.icon} size={21} color={t.accent} /></View>
          <View style={{ flex: 1, gap: 2 }}><Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{item.title}</Text><Text style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>{item.text}</Text></View>
        </Animated.View>)}
      </View>
      <Animated.View entering={FadeIn.delay(750 + NEWS.length * 110 + 150).duration(350)} style={{ alignSelf: 'stretch' }}>
        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Начать" style={state0 => ({ height: 50, borderRadius: 25, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: state0.pressed ? 0.8 : (state0 as { hovered?: boolean }).hovered ? 0.92 : 1 })}>
          <Text style={{ color: t.onAccent, fontSize: 16, fontWeight: '700' }}>Начать</Text>
        </Pressable>
      </Animated.View>
    </View>
  </Animated.View>;
}
