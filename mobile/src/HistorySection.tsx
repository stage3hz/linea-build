import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Text } from './typography';
import { Button, Field, Icon, Notice, SectionLabel, Sheet } from './components';
import { GlassSurface } from './glass';
import { useTheme } from './theme';
import type { Api } from './api';
import { historyRunner, useHistoryStatus } from './e2ee/historyRuntime';
import { currentSecret, disableBackup, enableBackup, restoreBackup, RestoreError, type BackupState } from './e2ee/historySync';
import { formatSecret, secretQr } from './e2ee/history';
import { qrMatrix } from './e2ee/qr';
import { getLockSettings, checkCode } from './lock/storage';
import { authenticateBiometric } from './lock/biometrics';
import { CodeEntry } from './lock/CodeEntry';

/**
 * Settings › Безопасность › «Переписки на новом устройстве» (docs/HISTORY-TRANSFER.md): how a copy from another own
 * device goes, the encrypted backup («Ключ резервной копии», shown behind the app lock) and «Восстановить переписки».
 * Mounted by SecurityScreen.tsx.
 */
const time = (value: string | null) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''; };
const words = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** The QR code of the backup key: one path of dark squares, with a quiet border. */
function KeyQr({ text, size = 220 }: { text: string; size?: number }) {
  const matrix = qrMatrix(text.toUpperCase());
  if (!matrix) return null;
  const quiet = 4, cells = matrix.length + quiet * 2;
  let d = '';
  matrix.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`; }));
  return <View accessible accessibilityLabel="QR-код ключа резервной копии" style={{ alignSelf: 'center', backgroundColor: '#ffffff', borderRadius: 16, padding: 6 }}>
    <Svg width={size} height={size} viewBox={`0 0 ${cells} ${cells}`}><Path d={d} fill="#000000" /></Svg>
  </View>;
}

export function HistorySection({ api }: { api: Api }) {
  const t = useTheme();
  const status = useHistoryStatus();
  const [backup, setBackup] = useState<BackupState | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [gate, setGate] = useState<null | 'code'>(null), [gateError, setGateError] = useState(''), [shake, setShake] = useState(0);
  const [restoring, setRestoring] = useState(false), [typed, setTyped] = useState(''), [restoreError, setRestoreError] = useState(''), [progress, setProgress] = useState('');
  const [scanning, setScanning] = useState(false);
  const [camera, requestCamera] = useCameraPermissions();
  const [confirmOff, setConfirmOff] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const runner = historyRunner();
    if (!runner) return;
    try {
      const deps = await runner.deps();
      await deps.crypto.initialize();
      const state = await api.backupState(deps.crypto.deviceId!);
      const secret = await currentSecret(deps, state).catch(() => null);
      if (alive.current) { setBackup(state); setHeld(secret); setError(''); }
    } catch (reason) { if (alive.current) setError(words(reason, 'Не удалось узнать состояние резервной копии.')); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const enable = async () => {
    const runner = historyRunner(); if (!runner || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const secret = await enableBackup(await runner.deps());
      if (!alive.current) return;
      setShown(secret); setHeld(secret);
      runner.poke('backup');
      await load();
    } catch (reason) { if (alive.current) setError(words(reason, 'Не удалось включить резервную копию.')); }
    finally { if (alive.current) setBusy(false); }
  };
  const disable = async () => {
    const runner = historyRunner(); if (!runner || busy) return;
    setBusy(true); setError(''); setConfirmOff(false);
    try { await disableBackup(await runner.deps()); if (alive.current) { setHeld(null); setNotice('Резервная копия удалена с сервера.'); } await load(); }
    catch (reason) { if (alive.current) setError(words(reason, 'Не удалось выключить резервную копию.')); }
    finally { if (alive.current) setBusy(false); }
  };
  /** The key is shown only after the app lock (code or Face ID / Touch ID) when the lock is on. */
  const showKey = async () => {
    if (!held) return;
    const settings = getLockSettings();
    if (!settings.record) { setShown(held); return; }
    if (settings.biometrics && await authenticateBiometric('Показать ключ резервной копии')) { setShown(held); return; }
    setGateError(''); setGate('code');
  };
  const submitCode = async (code: string) => {
    const record = getLockSettings().record;
    if (!record) { setGate(null); setShown(held); return; }
    if (await checkCode(code, record)) { setGate(null); setShown(held); }
    else { setGateError('Неверный код.'); setShake(value => value + 1); }
  };
  const restore = async (value = typed) => {
    const runner = historyRunner(); if (!runner || busy) return;
    setBusy(true); setRestoreError(''); setProgress('');
    try {
      const imported = await restoreBackup(await runner.deps(), value, (done, total) => { if (alive.current) setProgress(`Страница ${done} из ${total}`); });
      if (!alive.current) return;
      setRestoring(false); setTyped(''); setNotice(`Переписки восстановлены. Сообщений: ${imported}.`);
      runner.poke('history.ready');
      await load();
    } catch (reason) {
      if (alive.current) setRestoreError(reason instanceof RestoreError ? reason.message : words(reason, 'Не удалось восстановить переписки.'));
    } finally { if (alive.current) { setBusy(false); setProgress(''); } }
  };
  const scan = async () => {
    if (!camera?.granted) { const answer = await requestCamera(); if (!answer.granted) { setRestoreError('Нет доступа к камере. Введи ключ вручную или разреши камеру в настройках.'); return; } }
    setScanning(true);
  };

  const canRestore = !!backup?.enabled && !held;
  const restoreAt = backup?.restoreAt ? time(backup.restoreAt) : '';

  return <GlassSurface material="regular" radius={28} contentStyle={{ padding: 20, gap: 15 }}>
    <SectionLabel>Переписки на новом устройстве</SectionLabel>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Сообщения зашифрованы только для устройств, которые были в аккаунте, когда их отправили. Новое устройство получает старые переписки двумя способами — оба со сквозным шифрованием, сервер их не читает.</Text>
    {status.phase === 'receiving' ? <Notice text={`Переносим переписки с другого устройства… ${status.done} из ${status.total}`} /> : null}
    {status.phase !== 'receiving' && status.waitingUntil ? <Notice text={`Переписки придут с другого твоего устройства после ${time(status.waitingUntil)} (через 10 минут после входа). Оно должно быть в сети с открытым приложением.`} /> : null}
    {status.imported ? <Notice text={`Перенесено сообщений: ${status.imported}.`} /> : null}
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}><Icon name="phone-portrait-outline" color={t.accent} size={23} /><Text style={{ color: t.muted, fontSize: 13, lineHeight: 20, flex: 1 }}>С другого своего устройства: при новом входе твои устройства покажут «Новый вход». Если в течение 10 минут его не завершить, любое из них в сети передаст переписки новому — зашифрованными только для него.</Text></View>
    {error ? <Notice text={error} error onRetry={() => void load()} /> : null}
    {notice ? <Notice text={notice} /> : null}
    <SectionLabel>Резервная копия</SectionLabel>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Зашифрованная копия переписок на сервере. Ключ создаётся на устройстве и на сервер не уходит; твои устройства передают его друг другу в зашифрованном виде.</Text>
    <View style={{ borderRadius: 17, padding: 13, gap: 5, backgroundColor: t.accentSoft }}><Text style={{ color: t.text, fontSize: 12, fontWeight: '700' }}>Ключ = доступ к копии</Text><Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Кто знает ключ резервной копии и может войти в твой аккаунт, тот может прочитать её. Храни ключ так же бережно, как пароль: не отправляй его в чатах и не фотографируй на чужие устройства.</Text></View>
    {!backup ? <ActivityIndicator color={t.accent} /> : !backup.enabled ? <Button label="Включить резервную копию" secondary icon="cloud-upload-outline" loading={busy} onPress={() => void enable()} /> : held ? <>
      <Text style={{ color: t.muted, fontSize: 12 }}>{backup.updatedAt ? `Обновлена ${new Date(backup.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Включена'}</Text>
      <Button label="Ключ резервной копии" secondary icon="key-outline" disabled={busy} onPress={() => void showKey()} />
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => setConfirmOff(true)} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.danger, fontSize: 13, fontWeight: '700' }}>Выключить резервную копию</Text></Pressable>
    </> : canRestore ? <>
      {backup.canRestore ? <Button label="Восстановить переписки" icon="cloud-download-outline" disabled={busy} onPress={() => { setRestoreError(''); setRestoring(true); }} />
        : <Notice text={`Восстановить переписки можно после ${restoreAt} — через 10 минут после входа.`} />}
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Понадобится ключ резервной копии: его можно открыть на другом твоём устройстве в Безопасность → «Ключ резервной копии».</Text>
    </> : null}

    <Sheet visible={shown !== null} title="Ключ резервной копии" onClose={() => setShown(null)}>
      {shown ? <View style={{ gap: 16, paddingBottom: 8 }}>
        <Text selectable style={{ color: t.text, fontSize: 21, lineHeight: 30, fontWeight: '700', letterSpacing: 1, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{formatSecret(shown)}</Text>
        <KeyQr text={secretQr(shown)} />
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>На новом устройстве открой Безопасность → «Восстановить переписки» и введи ключ или наведи камеру на этот код. Кто знает ключ и может войти в аккаунт, тот может прочитать копию.</Text>
        <Button label="Готово" onPress={() => setShown(null)} />
      </View> : null}
    </Sheet>
    <Sheet visible={gate === 'code'} title="Код-пароль" onClose={() => setGate(null)}>
      <View style={{ paddingBottom: 8 }}>
        <CodeEntry kind={getLockSettings().record?.kind ?? 'digits'} title="Введи код-пароль" hint="Чтобы показать ключ резервной копии" error={gateError} shake={shake} onSubmit={code => void submitCode(code)} />
      </View>
    </Sheet>
    <Sheet visible={restoring} title="Восстановить переписки" onClose={() => { if (!busy) { setRestoring(false); setScanning(false); } }}>
      <View style={{ gap: 15, paddingBottom: 8 }}>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Введи ключ резервной копии с другого твоего устройства (9 групп по 4 символа) или отсканируй его QR-код. Попыток — 5 в час.</Text>
        {scanning ? <View style={{ height: 260, borderRadius: 20, overflow: 'hidden' }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={result => { if (!scanning) return; setScanning(false); setTyped(result.data); void restore(result.data); }} />
        </View> : null}
        <Field label="Ключ" value={typed} onChangeText={setTyped} placeholder="XXXX XXXX XXXX …" autoCapitalize="characters" autoCorrect={false} editable={!busy} />
        {progress ? <Text style={{ color: t.muted, fontSize: 12 }}>{progress}</Text> : null}
        {restoreError ? <Notice text={restoreError} error /> : null}
        <Button label="Восстановить" loading={busy} disabled={!typed.trim()} onPress={() => void restore()} />
        <Button label={scanning ? 'Убрать камеру' : 'Сканировать QR-код'} secondary icon="qr-code-outline" disabled={busy} onPress={() => { if (scanning) setScanning(false); else void scan(); }} />
      </View>
    </Sheet>
    <Sheet visible={confirmOff} title="Выключить резервную копию?" onClose={() => setConfirmOff(false)}>
      <View style={{ gap: 16, paddingBottom: 8 }}>
        <Text style={{ color: t.muted, fontSize: 14, lineHeight: 22 }}>Копия и её ключ будут удалены с сервера. Переписки на твоих устройствах останутся. Если включить копию снова, будет создан новый ключ.</Text>
        <Button label="Выключить" danger loading={busy} onPress={() => void disable()} />
      </View>
    </Sheet>
  </GlassSurface>;
}
