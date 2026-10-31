import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from './typography';
import { Avatar, Button, Icon, Notice, Sheet } from './components';
import { GlassSurface } from './glass';
import { useTheme } from './theme';
import { SecretInput } from './AuthScreen';
import type { Api } from './api';
import type { User } from './types';

/** Bottom of «Безопасность»: blocked people, then account deletion (App Store 5.1.1(v)). */
export function AccountZone({ api, confirmationConfigured, onDeleted }: { api: Api; confirmationConfigured: boolean; onDeleted: () => Promise<void> }) {
  const t = useTheme();
  const [blocked, setBlocked] = useState<User[] | null>(null);
  const [asking, setAsking] = useState(false); const [password, setPassword] = useState(''); const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const load = useCallback(() => { api.blocks().then(result => setBlocked(result.users)).catch(() => setBlocked([])); }, [api]);
  useEffect(load, [load]);
  const unblock = async (user: User) => { try { await api.unblock(user.id); setBlocked(list => (list || []).filter(item => item.id !== user.id)); } catch { /* the row stays */ } };
  const remove = async () => {
    if (!password) { setError('Введи пароль.'); return; }
    if (confirmationConfigured && !word.trim()) { setError('Введи слово подтверждения.'); return; }
    setBusy(true); setError('');
    try { await api.deleteAccount(password, word.trim()); setPassword(''); setWord(''); setAsking(false); await onDeleted(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось удалить аккаунт.'); }
    finally { setBusy(false); }
  };
  return <>
    <GlassSurface material="regular" radius={28} contentStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 }}>ЗАБЛОКИРОВАННЫЕ</Text>
      {blocked === null ? <ActivityIndicator color={t.accent} /> : blocked.length ? blocked.map(user => <View key={user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar user={user} api={api} size={40} />
        <View style={{ flex: 1 }}><Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{user.displayName}</Text><Text style={{ color: t.muted, fontSize: 12 }}>@{user.username}</Text></View>
        <Pressable accessibilityRole="button" onPress={() => void unblock(user)} hitSlop={6}><Text style={{ color: t.accent, fontSize: 14, fontWeight: '600' }}>Разблокировать</Text></Pressable>
      </View>) : <Text style={{ color: t.muted, fontSize: 13 }}>Никого нет. Заблокировать можно в профиле собеседника через «⋯».</Text>}
    </GlassSurface>
    <GlassSurface material="regular" radius={28} contentStyle={{ padding: 6 }}>
      <Pressable accessibilityRole="button" onPress={() => { setError(''); setAsking(true); }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 22, backgroundColor: pressed ? 'rgba(229,72,77,0.12)' : 'transparent' })}>
        <Icon name="trash-outline" size={20} color={t.danger} /><Text style={{ color: t.danger, fontSize: 15, fontWeight: '600' }}>Удалить аккаунт</Text>
      </Pressable>
    </GlassSurface>
    <Sheet visible={asking} title="Удалить аккаунт навсегда?" onClose={() => { if (!busy) setAsking(false); }}>
      <View style={{ gap: 14, paddingBottom: 8 }}>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Удалятся профиль, все личные чаты (у собеседников тоже), файлы, каналы и серверы, где ты владелец, твои сообщения в чужих каналах и устройства. Вернуть будет нельзя. Подписку Platina это не отменяет, если она оплачена через магазин приложений.</Text>
        <SecretInput label="Пароль" value={password} onChangeText={setPassword} placeholder="Пароль этого аккаунта" disabled={busy} />
        {confirmationConfigured ? <SecretInput label="Слово подтверждения" value={word} onChangeText={setWord} placeholder="Слово для входа" disabled={busy} /> : null}
        {error ? <Notice text={error} error /> : null}
        <Button label="Удалить навсегда" danger icon="trash-outline" loading={busy} disabled={busy} onPress={() => void remove()} />
      </View>
    </Sheet>
  </>;
}
