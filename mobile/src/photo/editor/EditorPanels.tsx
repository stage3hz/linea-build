// Bottom toolbar of the photo editor (Telegram-like): tabs and the options of the active tab.
import React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Text } from '../../typography';
import { Icon, type IconName } from '../../components';
import { BRUSH_RADII, PEN_COLORS, PEN_WIDTHS, type EditState } from '../editorHistory.ts';

export type EditorTab = 'crop' | 'draw' | 'remove' | 'background' | 'enhance' | 'size';
export const TABS: { id: EditorTab; icon: IconName; label: string }[] = [
  { id: 'crop', icon: 'crop-outline', label: 'Обрезка' },
  { id: 'draw', icon: 'brush-outline', label: 'Рисование' },
  { id: 'remove', icon: 'bandage-outline', label: 'Убрать объект' },
  { id: 'background', icon: 'image-outline', label: 'Фон' },
  { id: 'enhance', icon: 'sparkles-outline', label: 'Улучшить' },
  { id: 'size', icon: 'resize-outline', label: 'Размер и формат' },
];
export const ASPECTS: { label: string; spoken: string; value: number | null }[] = [
  { label: 'Свободно', spoken: 'Свободная обрезка', value: null }, { label: '1:1', spoken: 'Квадрат', value: 1 },
  { label: '4:3', spoken: 'Четыре к трём', value: 4 / 3 }, { label: '3:4', spoken: 'Три к четырём', value: 3 / 4 }, { label: '16:9', spoken: 'Шестнадцать к девяти', value: 16 / 9 },
];
const COLOR_NAMES = ['Белый', 'Чёрный', 'Красный', 'Оранжевый', 'Жёлтый', 'Зелёный', 'Синий', 'Фиолетовый'];
const ACCENT = '#4DA3FF', MUTED = '#9AA3B2', TEXT = '#F2F4F8';

function Chip({ label, spoken, selected, disabled, badge, onPress }: { label: string; spoken?: string; selected: boolean; disabled?: boolean; badge?: string; onPress: () => void }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="radio" accessibilityLabel={spoken ? `${spoken}${badge ? `, ${badge}` : ''}` : `${label}${badge ? `, ${badge}` : ''}`} accessibilityState={{ checked: selected, disabled }}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16, backgroundColor: selected ? 'rgba(10,132,255,0.28)' : 'rgba(255,255,255,0.09)', opacity: disabled ? .35 : pressed ? .7 : 1 })}>
    <Text style={{ color: selected ? ACCENT : TEXT, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    {badge ? <Text style={{ color: '#FFB340', fontSize: 10, fontWeight: '800' }}>{badge}</Text> : null}
  </Pressable>;
}

function Action({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.09)', opacity: disabled ? .35 : pressed ? .7 : 1 })}>
    <Icon name={icon} size={18} color={TEXT} /><Text style={{ color: TEXT, fontSize: 13, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}

const Row = ({ children }: { children: React.ReactNode }) => <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 14, alignItems: 'center' }}>{children}</ScrollView>;
const Hint = ({ children, warn }: { children: React.ReactNode; warn?: boolean }) => <Text style={{ color: warn ? '#FF8A80' : MUTED, fontSize: 12, lineHeight: 17, paddingHorizontal: 16 }}>{children}</Text>;

export type PanelProps = {
  tab: EditorTab; state: EditState; disabled: boolean; hdr: boolean;
  aspect: number | null; penColor: string; penWidth: number; brushRadius: number;
  backgroundRemoval: boolean; backgroundReady: boolean; backgroundReason?: string; preparingBackground: boolean;
  cropSourceTooLarge: boolean; sizeText: string;
  onAspect: (value: number | null) => void; onRotate: () => void; onFlip: () => void;
  onPenColor: (color: string) => void; onPenWidth: (width: number) => void; onBrush: (radius: number) => void;
  onChange: (next: EditState) => void; onPrepareBackground: () => void;
};

export function ToolPanel(p: PanelProps) {
  const { state } = p, sdr = p.hdr ? 'SDR' : undefined;
  const set = (patch: Partial<EditState>) => p.onChange({ ...state, ...patch });
  switch (p.tab) {
    case 'crop': return <View style={{ gap: 9 }}>
      <Row>
        {ASPECTS.map(item => <Chip key={item.label} label={item.label} spoken={item.spoken} selected={p.aspect === item.value} disabled={p.disabled} onPress={() => p.onAspect(item.value)} />)}
      </Row>
      <Row>
        <Action icon="refresh-outline" label="Повернуть на 90°" disabled={p.disabled} onPress={p.onRotate} />
        <Action icon="swap-horizontal-outline" label="Отразить" disabled={p.disabled} onPress={p.onFlip} />
      </Row>
      {p.cropSourceTooLarge ? <Hint warn>Точная обрезка доступна для фото до 16 Мп. Выбери «50 %» в «Размер и формат» или отправь фото без обрезки.</Hint> : null}
    </View>;
    case 'draw': return <View style={{ gap: 9 }}>
      <Row>
        {PEN_COLORS.map((color, index) => <Pressable key={color} onPress={() => p.onPenColor(color)} disabled={p.disabled} accessibilityRole="radio" accessibilityLabel={`Цвет: ${COLOR_NAMES[index]}`} accessibilityState={{ checked: p.penColor === color }}
          style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: color, borderWidth: p.penColor === color ? 3 : 1, borderColor: p.penColor === color ? ACCENT : 'rgba(255,255,255,0.45)' }} />)}
      </Row>
      <Row>{PEN_WIDTHS.map(item => <Chip key={item.value} label={item.label} spoken={`Толщина: ${item.label.toLowerCase()}`} selected={p.penWidth === item.value} disabled={p.disabled} onPress={() => p.onPenWidth(item.value)} />)}</Row>
    </View>;
    case 'remove': return <View style={{ gap: 9 }}>
      <Row>{BRUSH_RADII.map(item => <Chip key={item.value} label={item.label} spoken={`Кисть: ${item.label.toLowerCase()}`} selected={p.brushRadius === item.value} disabled={p.disabled} onPress={() => p.onBrush(item.value)} />)}</Row>
      <Hint>Закрась объект — область заполнится соседними цветами. Маска — до 20% кадра.</Hint>
      {state.crop ? <Hint>Предпросмотр считается по всему фото, а при отправке — по обрезанному кадру: у края кадра заполнение может немного отличаться.</Hint> : null}
    </View>;
    case 'background': return <View style={{ gap: 9 }}>
      <Row>
        <Chip label="Исходный" selected={state.background === 'keep'} disabled={p.disabled} onPress={() => set({ background: 'keep' })} />
        <Chip label="Без фона" badge={sdr ?? 'PNG'} spoken="Без фона, PNG" selected={state.background === 'transparent'} disabled={p.disabled || !p.backgroundRemoval || !p.backgroundReady} onPress={() => set({ background: 'transparent', document: 'none', format: 'png' })} />
        <Chip label="Белый" selected={state.background === 'white'} disabled={p.disabled || !p.backgroundRemoval || !p.backgroundReady} onPress={() => set({ background: 'white', document: 'none' })} />
        {p.backgroundRemoval && !p.backgroundReady ? <Action icon="download-outline" label={p.preparingBackground ? 'Готовим…' : 'Подготовить удаление фона'} disabled={p.disabled || p.preparingBackground} onPress={p.onPrepareBackground} /> : null}
      </Row>
      {!p.backgroundRemoval ? <Hint>{p.backgroundReason || 'Удаление фона недоступно на этом устройстве.'}</Hint> : null}
      {p.hdr ? <Hint>Без фона фото сохраняется без HDR. Белый фон сохраняет HDR.</Hint> : null}
      {Platform.OS === 'android' && p.backgroundRemoval ? <Hint>Удаление фона использует Google ML Kit на устройстве: фото не передаётся Google.</Hint> : null}
    </View>;
    case 'enhance': return <View style={{ gap: 9 }}>
      <Row>
        <Chip label="Фото" selected={state.document === 'none'} disabled={p.disabled} onPress={() => set({ document: 'none' })} />
        <Chip label="Ч/б документ" badge={sdr} selected={state.document === 'bw'} disabled={p.disabled} onPress={() => set({ document: 'bw', background: 'keep' })} />
        <Chip label="Цветной документ" badge={sdr} selected={state.document === 'color'} disabled={p.disabled} onPress={() => set({ document: 'color', background: 'keep' })} />
      </Row>
      <Row>
        {([1, 2, 4] as const).map(scale => <Chip key={scale} label={`×${scale}`} spoken={scale === 1 ? 'Без увеличения' : `Увеличить в ${scale} раза`} selected={state.scale === scale} disabled={p.disabled} onPress={() => set({ scale })} />)}
      </Row>
    </View>;
    case 'size': return <View style={{ gap: 9 }}>
      <Row>
        <Chip label="Полное" spoken="Полный размер" selected={state.resolution === 1} disabled={p.disabled} onPress={() => set({ resolution: 1 })} />
        <Chip label="50 %" spoken="Половина размера" selected={state.resolution === .5} disabled={p.disabled} onPress={() => set({ resolution: .5 })} />
        <Chip label="JPEG" selected={state.format === 'jpeg'} disabled={p.disabled || state.background === 'transparent'} onPress={() => set({ format: 'jpeg' })} />
        <Chip label="PNG" badge={sdr} selected={state.format === 'png'} disabled={p.disabled} onPress={() => set({ format: 'png' })} />
      </Row>
      <Hint>{p.sizeText}</Hint>
    </View>;
  }
}

export function TabBar({ tab, disabled, onTab }: { tab: EditorTab; disabled: boolean; onTab: (tab: EditorTab) => void }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 2, paddingHorizontal: 8 }}>
    {TABS.map(item => <Pressable key={item.id} onPress={() => onTab(item.id)} disabled={disabled} accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: tab === item.id, disabled }}
      style={({ pressed }) => ({ alignItems: 'center', gap: 3, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, minWidth: 62, opacity: disabled ? .4 : pressed ? .7 : 1, backgroundColor: tab === item.id ? 'rgba(10,132,255,0.2)' : 'transparent' })}>
      <Icon name={item.icon} size={22} color={tab === item.id ? ACCENT : TEXT} />
      <Text numberOfLines={1} style={{ color: tab === item.id ? ACCENT : '#D8DCE4', fontSize: 10.5 }}>{item.label}</Text>
    </Pressable>)}
  </ScrollView>;
}
