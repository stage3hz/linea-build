// Telegram «Выкл. звук»: a sheet with «На 1 час / На 8 часов / На 2 дня / Навсегда / Настроить…»; the
// last one opens a duration picker (days, hours, minutes) in the same sheet. Used from the chat list
// (swipe, long press, bulk) and the person's profile.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../typography';
import { Button, Icon, Sheet, SheetAction } from '../components';
import { useTheme } from '../theme';
import { lightFeedback } from '../haptics';
import { MUTE_CHOICES, customMuteUntil, durationLabel, muteEndLabel, muteUntil, muteUntilLabel, type CustomDuration } from './model';

type Props = {
  visible: boolean;
  /** The chat's name (one chat) or a count line for several («3 чата»). */
  title: string;
  /** The current mute of the chat, when there is one: offers «Включить звук» first. */
  current?: { muted?: boolean; mutedUntil?: string | null } | null;
  onClose: () => void;
  /** `until` is ISO, or null for «Навсегда». */
  onMute: (until: string | null) => void;
  onUnmute?: () => void;
};

export function MuteSheet({ visible, title, current, onClose, onMute, onUnmute }: Props) {
  const t = useTheme();
  const [custom, setCustom] = useState(false);
  const close = () => { setCustom(false); onClose(); };
  const pick = (until: string | null) => { lightFeedback(); setCustom(false); onMute(until); };
  return <Sheet visible={visible} title={custom ? 'На какое время?' : 'Выключить звук'} onClose={close}>
    {custom ? <DurationPicker onDone={until => pick(until)} onBack={() => setCustom(false)} /> : <>
      <Text numberOfLines={2} style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 6 }}>{title}</Text>
      {current?.muted && onUnmute ? <SheetAction icon="notifications-outline" label="Включить звук" description={`Сейчас звук выключен ${muteUntilLabel(current.mutedUntil)}.`} onPress={() => { lightFeedback(); setCustom(false); onUnmute(); }} /> : null}
      {MUTE_CHOICES.map(choice => <SheetAction key={choice.id} icon={choice.id === 'forever' ? 'notifications-off-outline' : 'time-outline'} label={choice.label} description={choice.ms ? `Без звука ${muteUntilLabel(muteUntil(choice.id))}.` : 'Пока не включишь снова. Звонки продолжат звонить.'} onPress={() => pick(muteUntil(choice.id))} />)}
      <SheetAction icon="options-outline" label="Настроить…" description="Своё время: дни, часы и минуты." onPress={() => { lightFeedback(); setCustom(true); }} />
    </>}
  </Sheet>;
}

const DAYS = [0, 1, 2, 3, 5, 7, 14, 30];
const HOURS = [0, 1, 2, 3, 4, 6, 8, 12, 18];
const MINUTES = [0, 15, 30, 45];

/** «Настроить…»: chips for days, hours and minutes with a live «Звук вернётся …» line, as the night-theme time picker. */
function DurationPicker({ onDone, onBack }: { onDone: (until: string) => void; onBack: () => void }) {
  const t = useTheme();
  const [duration, setDuration] = useState<CustomDuration>({ days: 0, hours: 1, minutes: 0 });
  const until = customMuteUntil(duration);
  const chip = (label: string, on: boolean, press: () => void) => <Pressable key={label} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { lightFeedback(); press(); }} style={{ minWidth: 52, height: 40, paddingHorizontal: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : t.surface2 }}><Text raw style={{ color: on ? t.onAccent : t.text, fontSize: 15, fontWeight: on ? '700' : '500' }}>{label}</Text></Pressable>;
  return <View style={{ gap: 14 }}>
    <Pressable accessibilityRole="button" onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}><Icon name="chevron-back" size={16} color={t.accent} /><Text style={{ color: t.accent, fontSize: 14, fontWeight: '600' }}>Назад</Text></Pressable>
    <Text raw style={{ color: t.text, fontSize: 22, fontWeight: '700', textAlign: 'center' }}>{durationLabel(duration) || '—'}</Text>
    <Text style={{ color: t.muted, fontSize: 12 }}>Дни</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{DAYS.map(x => chip(String(x), x === duration.days, () => setDuration(d => ({ ...d, days: x }))))}</View>
    <Text style={{ color: t.muted, fontSize: 12 }}>Часы</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{HOURS.map(x => chip(String(x), x === duration.hours, () => setDuration(d => ({ ...d, hours: x }))))}</View>
    <Text style={{ color: t.muted, fontSize: 12 }}>Минуты</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{MINUTES.map(x => chip(String(x), x === duration.minutes, () => setDuration(d => ({ ...d, minutes: x }))))}</View>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{until ? `Без звука до ${muteEndLabel(until)}.` : 'Выбери хотя бы несколько минут.'}</Text>
    <Button label="Выключить звук" disabled={!until} onPress={() => { if (until) onDone(until); }} />
  </View>;
}
