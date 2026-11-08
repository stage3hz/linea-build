import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from './typography';
import { Button, Icon, Notice, Sheet } from './components';
import { GlassSurface } from './glass';
import { useTheme } from './theme';
import type { Api } from './api';
import { dismissLogin, useNewLogins, type NewLogin } from './sessionAlerts';
import { deviceIcon } from './SecurityScreen';

/** «8 ноя, 18:36» for the sign-in time; «Неизвестно» when the server sent nothing usable. */
function when(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Неизвестно';
}

/**
 * «Новый вход» (Telegram-style): shown above the chat list when the server announced a sign-in
 * from another device (socket event `session.new`, kept in sessionAlerts.ts). «Это был я» hides the
 * notice; «Это был не я» ends that session on the server, so the stranger is signed out at once.
 * Wiring: App.tsx mounts <NewLoginNotice api={api}/> next to RecoveryNotice; useMessenger.ts
 * passes socket packets to noteSocketEvent().
 */
export function NewLoginNotice({ api, onOpenSecurity }: { api: Api; onOpenSecurity?: () => void }) {
  const t = useTheme();
  const logins = useNewLogins();
  const [open, setOpen] = useState<NewLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [ended, setEnded] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // The sign-in shown in the sheet may be acknowledged elsewhere (another notice tap): close with it.
  useEffect(() => { if (open && !ended && !logins.some(login => login.session.id === open.session.id)) setOpen(null); }, [logins, open, ended]);
  const latest = logins[0];
  if (!latest && !open) return null;

  const show = (login: NewLogin) => { setFailure(''); setEnded(false); setOpen(login); };
  const close = () => { if (!busy) { setOpen(null); setEnded(false); } };
  const itWasMe = () => { if (open) dismissLogin(open.session.id); setOpen(null); };
  const notMe = async () => {
    if (!open || busy) return;
    setBusy(true); setFailure('');
    try {
      await api.revokeSession(open.session.id);
      if (!live.current) return;
      setEnded(true); dismissLogin(open.session.id);
    } catch (reason) {
      if (live.current) setFailure(reason instanceof Error ? reason.message : 'Не удалось завершить сеанс. Открой Безопасность → Сеансы.');
    } finally { if (live.current) setBusy(false); }
  };
  const session = open?.session;

  return <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 }}>
    {latest ? <GlassSurface radius={18} material="regular" shadow={false}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Новый вход: ${latest.label}. Проверить`} onPress={() => show(latest)} style={{ padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54 }}>
        <Icon name={deviceIcon(latest.session)} color={t.danger} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 14 }} numberOfLines={1}>Новый вход: {latest.label}</Text>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{logins.length > 1 ? `Ещё входов: ${logins.length - 1}. ` : ''}Если это был не ты — заверши сеанс.</Text>
        </View>
        <Icon name="chevron-forward" size={18} color={t.muted} />
      </Pressable>
    </GlassSurface> : null}
    <Sheet visible={open !== null} title="Новый вход в аккаунт" onClose={close}>
      {session ? <View style={{ gap: 16, paddingBottom: 8 }}>
        {ended ? <Notice text="Сеанс завершён. На том устройстве понадобится снова ввести логин, пароль и слово подтверждения. Если пароль мог утечь — смени его в разделе «Безопасность»." /> : <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>В твой аккаунт вошли с другого устройства. Данные об устройстве сообщает само приложение; адрес — такой, каким его увидел сервер.</Text>}
        <View style={{ gap: 8, padding: 14, borderWidth: 1, borderColor: t.border, borderRadius: 18 }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{open?.label}</Text>
          <Row label="Устройство" value={session.deviceModel || session.deviceName || '—'} />
          <Row label="Система" value={session.osVersion || '—'} />
          <Row label="Приложение" value={session.appVersion ? `Инвиз ${session.appVersion}` : '—'} />
          <Row label="IP-адрес" value={session.ip || '—'} />
          <Row label="Вход" value={when(session.createdAt)} />
        </View>
        {failure ? <Notice text={failure} error /> : null}
        {ended ? <Button label="Понятно" onPress={close} /> : <>
          <Button label="Это был не я — завершить сеанс" danger icon="log-out-outline" loading={busy} onPress={() => void notMe()} />
          <Button label="Это был я" secondary icon="checkmark-outline" disabled={busy} onPress={itWasMe} />
          {onOpenSecurity ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => { close(); onOpenSecurity(); }} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.accent, fontSize: 13, fontWeight: '700' }}>Все сеансы и устройства</Text></Pressable> : null}
        </>}
      </View> : null}
    </Sheet>
  </View>;
}

function Row({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, width: 104 }}>{label}</Text>
    <Text style={{ color: t.text, fontSize: 13, lineHeight: 19, flex: 1 }} selectable>{value}</Text>
  </View>;
}
