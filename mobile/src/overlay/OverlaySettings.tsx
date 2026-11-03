// Настройки → Оверлей (PC): off by default; the person switches it on and picks where it sits.
import React, { useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { GlassSurface } from '../glass';
import { overlayPrefs, setOverlayPrefs, subscribeOverlay, type OverlayCorner } from './prefs';

function Row({ label, description, value, onChange }: { label: string; description?: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    <View style={{ flex: 1, gap: 2 }}><Text style={{ color: t.text, fontSize: 14.5 }}>{label}</Text>{description ? <Text style={{ color: t.muted, fontSize: 12 }}>{description}</Text> : null}</View>
    <View style={{ width: 44, height: 26, borderRadius: 13, padding: 3, backgroundColor: value ? t.accent : 'rgba(127,127,127,0.35)', alignItems: value ? 'flex-end' : 'flex-start' }}><View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF' }} /></View>
  </Pressable>;
}

export function OverlaySettings() {
  const t = useTheme(); const p = useSyncExternalStore(subscribeOverlay, overlayPrefs, overlayPrefs);
  const corners: [OverlayCorner, string][] = [['topLeft', 'Слева сверху'], ['topRight', 'Справа сверху'], ['bottomLeft', 'Слева снизу'], ['bottomRight', 'Справа снизу']];
  return <View style={{ gap: 16 }}>
    <GlassSurface radius={20} shadow={false} contentStyle={{ paddingVertical: 2, borderRadius: 20, overflow: 'hidden' }}>
      <Row label="Оверлей поверх игр" description="Кто в голосовом канале и кто сейчас говорит — маленьким списком поверх игры" value={p.enabled} onChange={v => setOverlayPrefs({ enabled: v })} />
      {p.enabled ? <Row label="Только говорящие" description="Показывать человека, только пока он говорит" value={p.onlySpeaking} onChange={v => setOverlayPrefs({ onlySpeaking: v })} /> : null}
    </GlassSurface>
    {p.enabled ? <>
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 8 }}>ПОЛОЖЕНИЕ</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {corners.map(([id, label]) => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: p.corner === id }} onPress={() => setOverlayPrefs({ corner: id })} style={{ flexBasis: '47%', flexGrow: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 12, backgroundColor: p.corner === id ? t.accent : 'rgba(127,127,127,0.14)' }}>
          <Text style={{ color: p.corner === id ? t.onAccent : t.text, fontWeight: '600', fontSize: 13.5 }}>{label}</Text>
        </Pressable>)}
      </View>
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 8 }}>ПРОЗРАЧНОСТЬ</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[[0.6, '60%'], [0.8, '80%'], [1, '100%']].map(([v, label]) => <Pressable key={label} onPress={() => setOverlayPrefs({ opacity: v as number })} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 12, backgroundColor: Math.abs(p.opacity - (v as number)) < 0.05 ? t.accent : 'rgba(127,127,127,0.14)' }}>
          <Text style={{ color: Math.abs(p.opacity - (v as number)) < 0.05 ? t.onAccent : t.text, fontWeight: '600', fontSize: 13.5 }}>{label}</Text>
        </Pressable>)}
      </View>
    </> : null}
    <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 8 }}>Появляется, только пока ты в голосовом канале и окно Инвиза не активно. Не перехватывает мышь и клавиатуру. Работает поверх игр в оконном и «полноэкранном оконном» режиме; в эксклюзивном полноэкранном режиме игра закрывает любые окна — Инвиз не встраивается в чужие программы.</Text>
  </View>;
}
