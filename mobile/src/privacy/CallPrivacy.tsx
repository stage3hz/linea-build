// «Кто может звонить»: все / только друзья / только разрешённые, плюс списки
// «Разрешить» и «Никогда» по @логину. Проверяет сервер; телефон получателя
// дополнительно не звонит, если звонящему нельзя.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import type { Api, CallMode, CallRules } from '../api';
import type { User } from '../types';
import { Avatar, Icon, Notice } from '../components';
import { Text } from '../typography';
import { useTheme } from '../theme';

const MODES: { value: CallMode; label: string; hint: string }[] = [
  { value: 'everyone', label: 'Все', hint: 'Позвонить может любой, кроме тех, кто в списке «Никогда».' },
  { value: 'contacts', label: 'Друзья', hint: 'Только люди из твоих друзей и из списка «Разрешить».' },
  { value: 'allowed', label: 'Разрешённые', hint: 'Только люди из списка «Разрешить».' },
];

export function CallPrivacy({ api, mode, disabled, onMode }: { api: Api; mode: CallMode; disabled?: boolean; onMode: (mode: CallMode) => void }) {
  const t = useTheme();
  const [rules, setRules] = useState<CallRules | null>(null), [error, setError] = useState('');
  const load = useCallback(() => { setError(''); api.callRules().then(setRules).catch(e => setError(e instanceof Error ? e.message : 'Не удалось загрузить списки.')); }, [api]);
  useEffect(load, [load]);
  const current = MODES.find(m => m.value === mode) || MODES[0];
  return <View style={{ padding: 14, gap: 12 }}>
    <View style={{ gap: 3 }}>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Кто может звонить</Text>
      <Text style={{ color: t.muted, fontSize: 12.5, lineHeight: 18 }}>{current.hint}</Text>
    </View>
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', padding: 3, borderRadius: 14, backgroundColor: t.surface2 }}>
      {MODES.map(item => { const on = item.value === mode; return <Pressable key={item.value} disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`Звонки: ${item.label}`} onPress={() => onMode(item.value)}
        style={{ flex: 1, minHeight: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : 'transparent' }}>
        <Text style={{ color: on ? t.onAccent : t.text, fontSize: 13, fontWeight: on ? '700' : '500' }}>{item.label}</Text>
      </Pressable>; })}
    </View>
    {error ? <Notice text={error} error onRetry={load} /> : null}
    {!rules ? <ActivityIndicator color={t.accent} /> : <>
      {mode !== 'everyone' ? <RuleList api={api} title="Разрешить" rule="allow" users={rules.allow} onRules={setRules} /> : null}
      <RuleList api={api} title="Никогда" rule="deny" users={rules.deny} onRules={setRules} />
    </>}
  </View>;
}

function RuleList({ api, title, rule, users, onRules }: { api: Api; title: string; rule: 'allow' | 'deny'; users: User[]; onRules: (rules: CallRules) => void }) {
  const t = useTheme();
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const add = async () => {
    const login = query.trim().replace(/^@/, '').toLowerCase();
    if (login.length < 2 || busy) return;
    setBusy(true); setError('');
    try {
      const found = (await api.users('@' + login)).users.find(user => user.username?.toLowerCase() === login);
      if (!found) { setError(`Пользователь @${login} не найден.`); return; }
      onRules(await api.setCallRule(found.id, rule)); setQuery('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось добавить.'); }
    finally { setBusy(false); }
  };
  const remove = async (user: User) => { try { onRules(await api.removeCallRule(user.id)); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось убрать.'); } };
  return <View style={{ gap: 8 }}>
    <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.1 }}>{title.toUpperCase()}{users.length ? ` · ${users.length}` : ''}</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 42, paddingLeft: 12, paddingRight: 4, borderRadius: 13, borderWidth: 1, borderColor: t.border }}>
      <Text style={{ color: t.muted, fontSize: 15 }}>@</Text>
      <TextInput value={query} onChangeText={value => { setQuery(value.replace(/\s/g, '')); setError(''); }} onSubmitEditing={() => void add()} placeholder="логин" placeholderTextColor={t.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="done"
        accessibilityLabel={`Добавить в список «${title}» по логину`} style={{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 8 }} maxLength={40} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Добавить в «${title}»`} disabled={busy || query.trim().replace(/^@/, '').length < 2} onPress={() => void add()} style={{ width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accentSoft, opacity: busy ? .6 : 1 }}>
        {busy ? <ActivityIndicator size="small" color={t.accent} /> : <Icon name="add" size={20} color={t.accent} />}
      </Pressable>
    </View>
    {error ? <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text> : null}
    {users.map(user => <View key={user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Avatar user={user} api={api} size={32} round />
      <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 14 }}>{user.displayName}</Text><Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>@{user.username}</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Убрать @${user.username} из «${title}»`} onPress={() => void remove(user)} hitSlop={8}><Icon name="close-circle" size={20} color={t.muted} /></Pressable>
    </View>)}
  </View>;
}
