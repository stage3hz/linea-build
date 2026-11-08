// Настройки › Конфиденциальность › Код-пароль (Telegram «Код-пароль»): turn the code on, change it,
// unlock with Face ID / Touch ID, the autolock delay, turn it off. With a code set, the section first asks
// for the current code, as Telegram does.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '../typography';
import { Icon, Sheet, SheetAction } from '../components';
import { Group, Item, Toggle } from '../SettingsScreen';
import { useTheme } from '../theme';
import { lightFeedback } from '../haptics';
import { CodeEntry } from './CodeEntry';
import { authenticateBiometric, biometricInfo, type BiometricInfo } from './biometrics';
import { AUTOLOCK_LABELS, AUTOLOCK_MODES, codeProblem, retryHint, type AutolockMode, type CodeKind } from './model';
import { checkCode, disableLock, enableLock, recordFailure, recordSuccess, setLockSettings, useLockSettings } from './storage';
import { useRetryWait } from './useRetryWait';

type Phase = { kind: 'verify' } | { kind: 'settings' } | { kind: 'setup'; change: boolean };

export function PasscodeSection() {
  const settings = useLockSettings();
  const enabled = !!settings.record;
  const [phase, setPhase] = useState<Phase>(enabled ? { kind: 'verify' } : { kind: 'settings' });
  if (phase.kind === 'verify' && settings.record) return <Verify onVerified={() => setPhase({ kind: 'settings' })} />;
  if (phase.kind === 'setup') return <Setup change={phase.change} onDone={() => setPhase({ kind: 'settings' })} onCancel={() => setPhase({ kind: 'settings' })} />;
  return <Settings onEnable={() => setPhase({ kind: 'setup', change: false })} onChange={() => setPhase({ kind: 'setup', change: true })} />;
}

/** The row for the privacy screen: «Код-пароль · Вкл./Выкл.». */
export function PasscodeRow({ onPress }: { onPress: () => void }) {
  const settings = useLockSettings();
  return <Item icon="keypad" color="#F0A030" label="Код-пароль" value={settings.record ? 'Вкл.' : 'Выкл.'} onPress={onPress} />;
}

// The same failure counter and wait as the lock screen: guessing here must cost exactly what it costs there.
function Verify({ onVerified }: { onVerified: () => void }) {
  const settings = useLockSettings(); const record = settings.record!;
  const [shake, setShake] = useState(0); const [wrong, setWrong] = useState(false); const [checking, setChecking] = useState(false);
  const wait = useRetryWait();
  const submit = async (code: string) => {
    if (checking || wait > 0) return; setChecking(true);
    try {
      if (await checkCode(code, record)) { lightFeedback(); void recordSuccess(); onVerified(); }
      else { setWrong(true); setShake(v => v + 1); void recordFailure(); }
    } finally { setChecking(false); }
  };
  return <View style={{ paddingTop: 12 }}><CodeEntry kind={record.kind} title={record.kind === 'digits' ? 'Введи текущий код-пароль' : 'Введи текущий пароль'} hint={wait > 0 ? retryHint(wait) : 'Чтобы менять настройки код-пароля, подтверди его'} error={wrong && wait <= 0 ? 'Неверный код-пароль' : undefined} shake={shake} disabled={checking || wait > 0} onSubmit={code => void submit(code)} /></View>;
}

function Setup({ change, onDone, onCancel }: { change: boolean; onDone: () => void; onCancel: () => void }) {
  const t = useTheme();
  const [kind, setKind] = useState<CodeKind>('digits');
  const [first, setFirst] = useState<string | null>(null);
  const [shake, setShake] = useState(0); const [clear, setClear] = useState(0); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const submit = async (code: string) => {
    if (saving) return;
    const problem = codeProblem(code, kind);
    if (problem) { setError(problem); setShake(v => v + 1); return; }
    // The first code is taken: a quiet clear for «Повтори», not the wrong-code shake.
    if (first === null) { setError(''); setFirst(code); setClear(v => v + 1); return; }
    if (code !== first) { setError('Коды не совпадают. Попробуй ещё раз'); setFirst(null); setShake(v => v + 1); return; }
    setSaving(true);
    try { await enableLock(code); lightFeedback(); onDone(); }
    catch { setError('Не удалось сохранить код-пароль на устройстве'); setFirst(null); setShake(v => v + 1); }
    finally { setSaving(false); }
  };
  const repeat = first !== null;
  const title = repeat ? (kind === 'digits' ? 'Повтори код-пароль' : 'Повтори пароль') : change ? (kind === 'digits' ? 'Введи новый код-пароль' : 'Введи новый пароль') : (kind === 'digits' ? 'Введи код-пароль' : 'Введи пароль');
  return <View style={{ paddingTop: 12 }}>
    <CodeEntry kind={kind} title={title} hint={repeat ? 'Ещё раз, чтобы не ошибиться' : 'Он будет запрашиваться при открытии Инвиза'} error={error || undefined} shake={shake} clear={clear} disabled={saving} onSubmit={code => void submit(code)}
      footer={<View style={{ alignItems: 'center', gap: 2, paddingTop: 6 }}>
        {!repeat ? <TextButton label={kind === 'digits' ? 'Использовать пароль' : 'Использовать 4-значный код'} onPress={() => { setKind(kind === 'digits' ? 'password' : 'digits'); setError(''); }} /> : null}
        <TextButton label="Отмена" muted onPress={onCancel} />
        {saving ? <ActivityIndicator color={t.accent} /> : null}
      </View>} />
  </View>;
}

function TextButton({ label, onPress, muted = false }: { label: string; onPress: () => void; muted?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, opacity: pressed ? 0.6 : 1 })}>
    <Text style={{ color: muted ? t.muted : t.accent, fontSize: 15, fontWeight: '600' }}>{label}</Text>
  </Pressable>;
}

function Settings({ onEnable, onChange }: { onEnable: () => void; onChange: () => void }) {
  const t = useTheme(); const settings = useLockSettings(); const enabled = !!settings.record;
  const [bio, setBio] = useState<BiometricInfo | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const [autolockOpen, setAutolockOpen] = useState(false);
  useEffect(() => { let alive = true; void biometricInfo().then(info => { if (alive) setBio(info); }); return () => { alive = false; }; }, []);
  // Telegram: turning Face ID / Touch ID on asks for it once, so the owner sees it works before relying on it.
  const toggleBiometrics = async (value: boolean) => {
    if (bioBusy) return;
    if (!value) { void setLockSettings({ biometrics: false }); return; }
    setBioBusy(true);
    try { if (await authenticateBiometric('Подтверди, что это ты')) { lightFeedback(); void setLockSettings({ biometrics: true }); } }
    finally { setBioBusy(false); }
  };
  if (!enabled) return <>
    <Group><Item icon="keypad" color="#F0A030" label="Включить код-пароль" onPress={onEnable} /></Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 8 }}>Когда код-пароль включён, при открытии Инвиза показывается экран блокировки. Код хранится только на этом устройстве в виде хеша: сервер его не знает.</Text>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 8 }}>Если ты забудешь код-пароль, придётся переустановить приложение (на компьютере — закрыть вкладку и войти снова).</Text>
  </>;
  return <>
    <Group>
      <Item icon="lock-open" color="#D9534F" label="Выключить код-пароль" danger onPress={() => { lightFeedback(); void disableLock(); }} />
      <Item icon="key" color="#3D8BFD" label="Сменить код-пароль" onPress={onChange} />
    </Group>
    {bio?.available ? <Group>
      <Toggle label={`Разблокировка ${bio.label}`} description="Открывать Инвиз без кода, когда система узнаёт тебя" value={settings.biometrics} disabled={bioBusy} onChange={value => void toggleBiometrics(value)} />
    </Group> : null}
    <Group>
      <Item icon="timer" color="#25A69A" label="Автоблокировка" value={AUTOLOCK_LABELS[settings.autolock]} onPress={() => setAutolockOpen(true)} />
    </Group>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 8 }}>Код-пароль запрашивается, если приложение не открывали дольше выбранного времени. «Сразу» блокирует при каждом уходе из Инвиза.</Text>
    <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 8 }}>После пяти неверных попыток следующая разрешается с нарастающей задержкой.</Text>
    <Sheet visible={autolockOpen} title="Автоблокировка" onClose={() => setAutolockOpen(false)}>
      {AUTOLOCK_MODES.map(mode => <SheetAction key={mode} icon={autolockIcon(mode)} label={AUTOLOCK_LABELS[mode]} selected={settings.autolock === mode} onPress={() => { lightFeedback(); void setLockSettings({ autolock: mode }); setAutolockOpen(false); }} />)}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 10 }}><Icon name="information-circle-outline" size={16} color={t.muted} /><Text style={{ flex: 1, color: t.muted, fontSize: 12, lineHeight: 17 }}>«Выключена»: код запрашивается только при запуске приложения, а не при возвращении в него.</Text></View>
    </Sheet>
  </>;
}
const autolockIcon = (mode: AutolockMode) => mode === 'off' ? 'close-circle-outline' : mode === 'immediate' ? 'flash-outline' : 'time-outline';
