import React, { useState } from 'react';
import { Animated, Pressable, Switch, View } from 'react-native';
import { Text, TextInput } from './typography';
import { Button, Icon, IconButton, Sheet } from './components';
import { useTheme } from './theme';
import { POLL_LIMITS, type Poll, type PollResults } from './messageMeta';
import { lightFeedback } from './haptics';

const plural = (n: number) => n % 10 === 1 && n % 100 !== 11 ? 'голос' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'голоса' : 'голосов';

/** A Telegram-style poll: tap an option to vote; results with bars appear after voting. */
export function PollBubble({ poll, results, onVote, disabled = false }: { poll: Poll; results?: PollResults; onVote: (options: number[]) => void; disabled?: boolean }) {
  const t = useTheme();
  const mine = results?.mine ?? [], voted = mine.length > 0, total = results?.counts.reduce((a, b) => a + b, 0) ?? 0;
  const [draft, setDraft] = useState<number[]>([]);
  const choose = (index: number) => {
    if (disabled) return;
    lightFeedback();
    if (voted) return;
    if (!poll.multiple) { onVote([index]); return; }
    setDraft(current => current.includes(index) ? current.filter(i => i !== index) : [...current, index]);
  };
  return <View style={{ minWidth: 230, maxWidth: 290, gap: 8, paddingVertical: 2 }}>
    <Text style={{ color: t.text, fontSize: 15, fontWeight: '700', lineHeight: 20 }}>{poll.question}</Text>
    <Text style={{ color: t.muted, fontSize: 11 }}>{poll.multiple ? 'Опрос · несколько ответов' : 'Опрос'}</Text>
    {poll.options.map((option, index) => {
      const count = results?.counts[index] ?? 0, share = total ? count / total : 0, chosen = mine.includes(index), picked = draft.includes(index);
      return <Pressable key={index} accessibilityRole={poll.multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked: chosen || picked, disabled: disabled || voted }} onPress={() => choose(index)} style={{ gap: 4, paddingVertical: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {voted ? <Text style={{ width: 38, color: t.text, fontSize: 13, fontWeight: '700' }}>{Math.round(share * 100)}%</Text> : <Icon name={poll.multiple ? (picked ? 'checkbox' : 'square-outline') : 'ellipse-outline'} size={20} color={picked ? t.accent : t.muted} />}
          <Text style={{ flex: 1, color: t.text, fontSize: 14 }}>{option}</Text>
          {chosen ? <Icon name="checkmark-circle" size={17} color={t.accent} /> : null}
        </View>
        {voted ? <View style={{ height: 4, borderRadius: 2, marginLeft: 46, backgroundColor: t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}><View style={{ width: `${Math.max(2, share * 100)}%`, height: 4, borderRadius: 2, backgroundColor: chosen ? t.accent : t.subtle }} /></View> : null}
      </Pressable>;
    })}
    {poll.multiple && !voted ? <Pressable disabled={!draft.length || disabled} onPress={() => { onVote([...draft].sort((a, b) => a - b)); setDraft([]); }} style={{ alignItems: 'center', paddingVertical: 8, opacity: draft.length ? 1 : .4 }}><Text style={{ color: t.accent, fontWeight: '700', fontSize: 14 }}>Голосовать</Text></Pressable> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ color: t.muted, fontSize: 11 }}>{results?.voters ? `${results.voters} ${plural(results.voters)}` : 'Пока нет голосов'}</Text>
      {voted && !disabled ? <Pressable onPress={() => { lightFeedback(); onVote([]); }} hitSlop={8}><Text style={{ color: t.accent, fontSize: 12 }}>Отменить голос</Text></Pressable> : null}
    </View>
  </View>;
}

export function PollComposer({ visible, onClose, onSend }: { visible: boolean; onClose: () => void; onSend: (poll: Poll) => void }) {
  const t = useTheme();
  const [question, setQuestion] = useState(''), [options, setOptions] = useState(['', '']), [multiple, setMultiple] = useState(false);
  const clean = options.map(o => o.trim()).filter(Boolean);
  const ready = question.trim().length > 0 && clean.length >= POLL_LIMITS.minOptions;
  const reset = () => { setQuestion(''); setOptions(['', '']); setMultiple(false); };
  const field = { color: t.text, fontSize: 15, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 14, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border } as const;
  return <Sheet visible={visible} title="Новый опрос" onClose={onClose}>
    <View style={{ gap: 10 }}>
      <TextInput value={question} onChangeText={setQuestion} maxLength={POLL_LIMITS.question} placeholder="Вопрос" placeholderTextColor={t.muted} style={field} />
      {options.map((value, index) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <TextInput value={value} onChangeText={text => setOptions(current => current.map((o, i) => i === index ? text : o))} maxLength={POLL_LIMITS.option} placeholder={`Вариант ${index + 1}`} placeholderTextColor={t.muted} style={[field, { flex: 1 }]} />
        {options.length > 2 ? <IconButton name="close" label="Убрать вариант" size={18} onPress={() => setOptions(current => current.filter((_o, i) => i !== index))} style={{ width: 34, height: 34 }} /> : null}
      </View>)}
      {options.length < POLL_LIMITS.maxOptions ? <Pressable onPress={() => setOptions(current => [...current, ''])} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}><Icon name="add-circle-outline" size={20} color={t.accent} /><Text style={{ color: t.accent, fontSize: 14, fontWeight: '600' }}>Добавить вариант</Text></Pressable> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}><Text style={{ color: t.text, fontSize: 14 }}>Несколько ответов</Text><Switch value={multiple} onValueChange={setMultiple} /></View>
      <Button label="Отправить опрос" icon="stats-chart-outline" disabled={!ready} onPress={() => { onSend({ question: question.trim(), options: clean, multiple }); reset(); }} />
    </View>
  </Sheet>;
}

/** Fades and lifts a freshly arrived message, like Telegram's bubble entrance. */
export function useEntrance(fresh: boolean) {
  const [value] = useState(() => new Animated.Value(fresh ? 0 : 1));
  React.useEffect(() => { if (fresh) Animated.spring(value, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 6 }).start(); }, []);
  return { opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }, { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] };
}
