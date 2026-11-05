// Model choice like in the Claude app: a pill «Умная ⌄» next to the input opens a small menu above it —
// each model with one line about what it is good for, a check on the current one, and «Другие модели»
// unfolding the concrete models the server has right now. Locked entries (no Platina) explain why.
import React, { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Text } from '../typography';
import { Icon } from '../components';
import { useTheme } from '../theme';

export type ModelEntry = { id: string; label: string; help?: string };

export function ModelMenu({ value, entries, more, locked, note, onChange, onLocked }: {
  value: string; entries: ModelEntry[]; more: ModelEntry[]; locked: boolean; note?: string;
  onChange: (id: string) => void; onLocked: () => void;
}) {
  const t = useTheme(); const window = useWindowDimensions();
  const pill = useRef<View>(null);
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState({ x: 16, bottom: 120 });
  const current = [...entries, ...more].find(entry => entry.id === value)?.label || value;
  const show = () => {
    const node = pill.current as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
    if (node?.measureInWindow) node.measureInWindow((x, y) => setAnchor({ x: Math.max(8, Math.min(x, window.width - 308)), bottom: Math.max(8, window.height - y + 8) }));
    setExpanded(false); setOpen(true);
  };
  const row = (entry: ModelEntry, lockedRow: boolean) => <Pressable key={entry.id} accessibilityRole="radio" accessibilityState={{ selected: value === entry.id, disabled: lockedRow }}
    onPress={() => { setOpen(false); if (lockedRow) { setTimeout(onLocked, 250); return; } onChange(entry.id); }}
    style={state => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? t.surface2 : 'transparent' })}>
    <View style={{ flex: 1, gap: 2 }}>
      <Text numberOfLines={1} style={{ color: lockedRow ? t.muted : t.text, fontSize: 14, fontWeight: '600' }}>{entry.label}</Text>
      {entry.help ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 16 }}>{entry.help}</Text> : null}
    </View>
    {lockedRow ? <Icon name="lock-closed" size={14} color={t.muted} /> : value === entry.id ? <Icon name="checkmark" size={18} color={t.accent} /> : null}
  </Pressable>;
  return <>
    <Pressable ref={pill} accessibilityRole="button" accessibilityLabel={`Модель AI: ${current}. Выбрать другую`} onPress={show}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, height: 42, paddingHorizontal: 12, borderRadius: 21, opacity: pressed ? .7 : 1 })}>
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 14, fontWeight: '500', maxWidth: 150 }}>{current}</Text>
      <Icon name="chevron-down" size={15} color={t.muted} />
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable accessibilityLabel="Закрыть выбор модели" onPress={() => setOpen(false)} style={{ flex: 1 }}>
        <Pressable onPress={() => {}} style={{ position: 'absolute', left: anchor.x, bottom: anchor.bottom, width: 300, maxHeight: Math.min(460, window.height - anchor.bottom - 40), borderRadius: 18, backgroundColor: t.dark ? '#262628' : '#FFFFFF', borderWidth: 1, borderColor: t.glassBorder, padding: 6, shadowColor: '#000', shadowOpacity: .25, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12 }}>
          <ScrollView bounces={false}>
            {entries.map(entry => row(entry, locked && entry.id !== value))}
            {more.length ? <>
              <View style={{ height: 1, backgroundColor: t.border, marginVertical: 4, marginHorizontal: 8 }} />
              <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => locked ? (setOpen(false), setTimeout(onLocked, 250)) : setExpanded(value0 => !value0)}
                style={state => ({ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? t.surface2 : 'transparent' })}>
                <Text style={{ flex: 1, color: t.text, fontSize: 14 }}>Другие модели</Text>
                <Icon name={locked ? 'lock-closed' : expanded ? 'chevron-up' : 'chevron-forward'} size={15} color={t.muted} />
              </Pressable>
              {expanded ? more.map(entry => row(entry, false)) : null}
            </> : null}
            {note ? <Text style={{ color: t.muted, fontSize: 11, lineHeight: 15, paddingHorizontal: 12, paddingVertical: 8 }}>{note}</Text> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}
