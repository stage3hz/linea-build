import React, { useState } from 'react';
import { Linking, Modal, Platform, Pressable, View } from 'react-native';
import { Text } from '../typography';
import { Button, Icon, Notice } from '../components';
import { useTheme, formatSize } from '../theme';
import { APP_VERSION } from '../serverConfig';
import { desktopBridge } from '../desktop';
import { assetFor, canSelfUpdate, downloadAndInstall, type Phase } from './install';
import { dismissUpdate, useUpdateState } from './store';

/** Mandatory: covers the whole app. Optional: a dismissible window, shown once per version. */
export function UpdateGate({ children }: { children: React.ReactNode }) {
  const update = useUpdateState();
  if (update.required) return <UpdateScreen required />;
  return <>{children}{update.available && !update.dismissed ? <Modal visible transparent animationType="fade" onRequestClose={dismissUpdate}><UpdateScreen required={false} /></Modal> : null}</>;
}

export function UpdateScreen({ required }: { required: boolean }) {
  const t = useTheme();
  const { info } = useUpdateState();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const asset = info ? assetFor(info) : null;
  const automatic = !!asset && canSelfUpdate();
  const busy = !!phase && !opened;
  const install = async () => {
    if (!info?.version || !asset) return;
    setError(''); setOpened(false); setPhase({ step: 'download', progress: 0 });
    try { await downloadAndInstall(asset, info.version, setPhase); setOpened(true); }
    catch (e) { setPhase(null); setError(e instanceof Error ? e.message : 'Не удалось обновить приложение.'); }
  };
  const label = !phase ? '' : phase.step === 'download' ? `Скачиваем… ${Math.round(phase.progress * 100)}%` : phase.step === 'verify' ? `Проверяем файл… ${Math.round(phase.progress * 100)}%` : 'Открываем установщик…';
  return <View style={{ flex: 1, backgroundColor: required ? t.bg : 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}>
    <View style={{ maxWidth: 420, width: '100%', alignSelf: 'center', gap: 16, padding: 24, borderRadius: 28, backgroundColor: t.dark ? '#151B2C' : '#FFFFFF', borderWidth: 1, borderColor: t.border }}>
      <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}><Icon name="cloud-download-outline" size={32} color={t.accent} /></View>
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', textAlign: 'center', letterSpacing: -.4 }}>{required ? 'Требуется обновление' : 'Доступна новая версия'}</Text>
      <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>
        {required ? 'Эта версия Инвиза больше не поддерживается. Установи новую — переписка и аккаунт сохранятся.' : 'Вышло обновление Инвиза. Переписка и аккаунт сохранятся.'}
      </Text>
      <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>{info?.version ? `Новая версия ${info.version}${asset ? ` · ${formatSize(asset.size)}` : ''} · у тебя ${APP_VERSION}` : `У тебя ${APP_VERSION}`}</Text>
      {phase ? <View style={{ gap: 8 }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: t.surface2, overflow: 'hidden' }}><View style={{ width: `${Math.round((phase.step === 'install' ? 1 : phase.progress) * 100)}%`, height: 6, backgroundColor: t.accent }} /></View>
        <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>{opened ? (desktopBridge() ? 'Установщик открыт. Приложение сейчас закроется.' : 'Подтверди установку в системном окне. Если Android попросит — разреши установку из Инвиза.') : label}</Text>
      </View> : null}
      {error ? <Notice error text={error} /> : null}
      {automatic ? <Button icon="download-outline" label={opened ? 'Открыть установщик ещё раз' : 'Установить'} loading={busy} disabled={busy} onPress={() => void install()} />
        : info?.page ? <Button icon="open-outline" label="Открыть страницу загрузки" onPress={() => void Linking.openURL(info.page!)} /> : null}
      {!automatic && Platform.OS === 'ios' ? <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>На iPhone новую версию нужно скачать и подписать, как обычно.</Text> : null}
      {!required && !busy ? <Pressable onPress={dismissUpdate} accessibilityRole="button" style={{ alignSelf: 'center', padding: 10 }}><Text style={{ color: t.muted, fontSize: 14 }}>Позже</Text></Pressable> : null}
    </View>
  </View>;
}
