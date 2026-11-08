// Composer formatting bar (Telegram: select text → «Жирный, Курсив, …»). Shown above the field
// while a selection exists; a tap toggles the style on the selected range. «Ссылка» asks for a URL.
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from '../typography';
import { useTheme } from '../theme';
import { tr } from '../i18n';
import { Button, Icon, Sheet } from '../components';
import { ENTITY_LABELS, validLinkUrl, type EntityType } from './entities';

export type ToolbarAction = EntityType | 'clear';
// The letters are interface text (Ж/К/Ч/З → B/I/U/S in English), the symbols are the same everywhere.
const ITEMS: { type: EntityType; label: string; style?: object }[] = [
  { type: 'bold', label: 'Ж', style: { fontWeight: '800' } },
  { type: 'italic', label: 'К', style: { fontStyle: 'italic' } },
  { type: 'underline', label: 'Ч', style: { textDecorationLine: 'underline' } },
  { type: 'strikethrough', label: 'З', style: { textDecorationLine: 'line-through' } },
  { type: 'code', label: '</>', style: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) } },
  { type: 'spoiler', label: '▒' },
  { type: 'quote', label: '❝' },
  { type: 'text_link', label: '🔗' },
];

export function FormatToolbar({ active, onAction, onLink, compact = false }: { active: ReadonlySet<EntityType>; onAction: (type: Exclude<ToolbarAction, 'text_link'>) => void; onLink: (url: string) => void; compact?: boolean }) {
  const t = useTheme();
  const [linkAsk, setLinkAsk] = useState(false);
  return <View style={{ paddingHorizontal: 4, paddingBottom: 6 }}>
    <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 4 }}>
      {ITEMS.map(item => {
        const on = active.has(item.type);
        return <Pressable key={item.type} accessibilityRole="button" accessibilityLabel={tr(ENTITY_LABELS[item.type])} accessibilityState={{ selected: on }} hitSlop={4}
          onPress={() => item.type === 'text_link' ? setLinkAsk(true) : onAction(item.type)}
          style={({ pressed }) => ({ minWidth: compact ? 34 : 38, height: 32, paddingHorizontal: 9, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : pressed ? t.accentSoft : t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' })}>
          <Text style={[{ color: on ? t.onAccent : t.text, fontSize: 15 }, item.style as object]}>{item.label}</Text>
        </Pressable>;
      })}
      <Pressable accessibilityRole="button" accessibilityLabel={tr('Очистить форматирование')} hitSlop={4} onPress={() => onAction('clear')}
        style={({ pressed }) => ({ height: 32, paddingHorizontal: 9, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.accentSoft : 'transparent' })}>
        <Icon name="close-circle-outline" size={18} color={t.muted} />
      </Pressable>
    </ScrollView>
    <LinkSheet visible={linkAsk} onClose={() => setLinkAsk(false)} onDone={url => { setLinkAsk(false); onLink(url); }} />
  </View>;
}

/** «Ссылка»: the address for the selected text. Only http(s) is accepted; «https://» is added when missing. */
export function LinkSheet({ visible, initial = '', onClose, onDone }: { visible: boolean; initial?: string; onClose: () => void; onDone: (url: string) => void }) {
  const t = useTheme();
  const [value, setValue] = useState(initial);
  useEffect(() => { if (visible) setValue(initial); }, [visible, initial]);
  const trimmed = value.trim();
  const url = !trimmed ? '' : /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const ok = validLinkUrl(url);
  return <Sheet visible={visible} title="Ссылка" onClose={onClose}>
    <TextInput autoFocus value={value} onChangeText={setValue} placeholder="https://" placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="done" onSubmitEditing={() => { if (ok) onDone(url); }} accessibilityLabel={tr('Адрес ссылки')} selectionColor={t.accent} keyboardAppearance={t.dark ? 'dark' : 'light'}
      style={{ color: t.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, marginBottom: 12 }} />
    {trimmed && !ok ? <Text style={{ color: t.danger, fontSize: 12, marginBottom: 10 }}>Нужен адрес вида https://…</Text> : null}
    <Button label="Готово" disabled={!ok} onPress={() => onDone(url)} />
  </Sheet>;
}
