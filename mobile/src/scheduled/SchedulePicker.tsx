import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text, TextInput } from '../typography';
import { Icon, Sheet, SheetAction } from '../components';
import { useTheme } from '../theme';
import { dayLabel, formatDeliverAt, schedulePresets, validateDeliverAt, withDayTime } from './model';

/**
 * «Отправить позже» (Telegram: long-press on Send → Schedule message): quick presets, or a day
 * (stepped with ‹ ›, up to a year ahead) with an hour and a minute typed in. The chosen moment is
 * handed back as an ISO time; the message is encrypted now and the server releases it then.
 */
export function SchedulePicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (deliverAt: string) => void }) {
  const t = useTheme();
  const [now, setNow] = useState(() => new Date());
  const presets = useMemo(() => schedulePresets(now), [now]);
  const [dayOffset, setDayOffset] = useState(0);
  const [hour, setHour] = useState('00');
  const [minute, setMinute] = useState('00');
  // Every time the sheet opens: «now» and the suggested time (the next whole hour, tomorrow after 23:00) are taken afresh, not at mount.
  useEffect(() => {
    if (!visible) return;
    const opened = new Date(); setNow(opened);
    const next = (opened.getHours() + 1) % 24;
    setHour(String(next).padStart(2, '0')); setMinute('00'); setDayOffset(next === 0 ? 1 : 0);
  }, [visible]);
  const day = useMemo(() => { const d = new Date(now); d.setDate(now.getDate() + dayOffset); return d; }, [now, dayOffset]);
  const custom = useMemo(() => {
    const h = Number(hour), m = Number(minute);
    if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute) || h > 23 || m > 59) return null;
    return withDayTime(day, h, m);
  }, [day, hour, minute]);
  const problem = custom ? validateDeliverAt(custom, now) : 'Укажи время в виде ЧЧ:ММ.';
  const pick = (at: Date) => { const error = validateDeliverAt(at, new Date()); if (error) return; onPick(at.toISOString()); };
  const step = (delta: number) => setDayOffset(current => Math.max(0, Math.min(365, current + delta)));
  const field = { width: 56, textAlign: 'center' as const, fontSize: 22, fontWeight: '700' as const, color: t.text, paddingVertical: 8, borderRadius: 12, backgroundColor: t.surface2 };
  return <Sheet visible={visible} title="Отправить позже" onClose={onClose}>
    {presets.map(preset => <SheetAction key={preset.label} icon="time-outline" label={preset.label} description={formatDeliverAt(preset.at.toISOString(), now)} onPress={() => pick(preset.at)} />)}
    <View style={{ marginTop: 10, padding: 14, borderRadius: 20, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, gap: 12 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 1.2, color: t.muted, textTransform: 'uppercase' }}>Другое время</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Днём раньше" disabled={dayOffset === 0} onPress={() => step(-1)} hitSlop={8} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', opacity: dayOffset === 0 ? .3 : 1 }}><Icon name="chevron-back" color={t.accent} /></Pressable>
        <Text style={{ fontSize: 17, fontWeight: '600', color: t.text }}>{dayLabel(day, now)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Днём позже" disabled={dayOffset >= 365} onPress={() => step(1)} hitSlop={8} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', opacity: dayOffset >= 365 ? .3 : 1 }}><Icon name="chevron-forward" color={t.accent} /></Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <TextInput value={hour} onChangeText={value => setHour(value.replace(/\D/g, '').slice(0, 2))} keyboardType="number-pad" maxLength={2} accessibilityLabel="Часы" selectTextOnFocus style={field} />
        <Text style={{ fontSize: 22, fontWeight: '700', color: t.text }}>:</Text>
        <TextInput value={minute} onChangeText={value => setMinute(value.replace(/\D/g, '').slice(0, 2))} keyboardType="number-pad" maxLength={2} accessibilityLabel="Минуты" selectTextOnFocus style={field} />
      </View>
      {problem ? <Text style={{ fontSize: 12, color: t.muted, textAlign: 'center' }}>{problem}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!!problem} onPress={() => custom && pick(custom)} style={({ pressed }) => ({ height: 46, borderRadius: 16, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', opacity: problem ? .4 : pressed ? .75 : 1 })}>
        <Text style={{ color: t.onAccent, fontSize: 15, fontWeight: '700' }}>{custom && !problem ? `Запланировать: ${formatDeliverAt(custom.toISOString(), now)}` : 'Запланировать'}</Text>
      </Pressable>
    </View>
  </Sheet>;
}
