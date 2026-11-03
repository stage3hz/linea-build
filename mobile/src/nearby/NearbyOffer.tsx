// The one-button explanation (first time) and the «Включить» banner (every time after).
import React from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { GlassSurface } from '../glass';
import { Button } from '../components';
import { useNearby } from './useNearby';

export function NearbyOffer() {
  const t = useTheme();
  const { offer, act } = useNearby();
  if (offer.kind === 'none') return null;
  if (offer.kind === 'intro') {
    // Only one way forward, as Apple asks for explanations shown before a permission question.
    return <Modal transparent animationType="fade" visible statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.45)' }}>
        <GlassSurface radius={26} contentStyle={{ padding: 22, gap: 14, alignItems: 'center' }}>
          <View style={{ width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent }}><Ionicons name="bluetooth" size={30} color={t.onAccent} /></View>
          <Text style={{ color: t.text, fontSize: 20, fontWeight: '700', textAlign: 'center' }}>Отправлять без интернета?</Text>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>Сообщения пойдут через Mesh — по Bluetooth через телефоны людей с Инвизом рядом. Шифрование то же.{'\n\n'}• Собеседник рядом — секунды.{'\n'}• Через других людей — от минут до нескольких часов.{'\n'}• Не дойдёт, если рядом никого с Инвизом.{'\n\n'}Дальше телефон спросит разрешение — нажмите «Разрешить».</Text>
          <View style={{ alignSelf: 'stretch' }}><Button label="Отправлять без интернета" icon="bluetooth" onPress={() => void act()} /></View>
        </GlassSurface>
      </View>
    </Modal>;
  }
  return <View accessibilityRole="alert" style={{ paddingHorizontal: 12, paddingTop: 6 }}>
    <GlassSurface radius={18} shadow={false} contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 14 }}>
      <Ionicons name="bluetooth" size={20} color={t.accent} />
      <Text style={{ flex: 1, color: t.text, fontSize: 13, lineHeight: 18 }}>Нет интернета. Можно отправлять через Mesh — людей с Инвизом рядом.</Text>
      <Pressable onPress={() => void act()} accessibilityRole="button" accessibilityLabel="Включить связь без интернета" hitSlop={10} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: t.accent }}>
        <Text style={{ color: t.onAccent, fontWeight: '700', fontSize: 13 }}>Включить</Text>
      </Pressable>
    </GlassSurface>
  </View>;
}
