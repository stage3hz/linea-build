// The lock over the whole app (Telegram «Код-пароль»): a full-screen surface above every screen and
// sheet, opened on start when a code is set, on return after the autolock delay, or at once on leaving
// with «Сразу». Nothing under it is touchable until the right code (or Face ID / Touch ID) opens it.
//
// iOS: a <Modal> cannot present while another Modal or Sheet is up (the app has ~25 of them), so the lock
// is drawn in react-native-screens' FullWindowOverlay — a view added to the UIWindow itself, above the
// presented modals. A Modal opened *after* locking (an incoming CallScreen) is added to the window later
// and so shows above the lock; Telegram behaves the same with an incoming call, and the call UI is the one
// thing that must not be blocked while locked. Android / web keep a Modal (Android can stack them).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, Platform, ScrollView, StyleSheet, View, type AppStateStatus } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../typography';
import { Button, Logo } from '../components';
import { GlassBackdrop } from '../glass';
import { useTheme } from '../theme';
import { lightFeedback } from '../haptics';
import { CodeEntry } from './CodeEntry';
import { authenticateBiometric, biometricInfo, type BiometricInfo } from './biometrics';
import { INACTIVE_LOCK_GRACE_MS, LOCKED_PATCH, onLeave, retryHint, shouldLockOnLaunch, shouldLockOnReturn } from './model';
import { checkCode, getLockSettings, loadLockSettings, lockSettingsLoaded, recordFailure, recordSuccess, setLockSettings, useLockSettings } from './storage';
import { useRetryWait } from './useRetryWait';

const lockListeners = new Set<() => void>();
/** Locks the app now (a lock button, a hot key): nothing happens when no code is set. */
export function lockNow() { if (getLockSettings().record) lockListeners.forEach(listener => listener()); }

// Web: global key / paste / drop handlers (Ctrl+K, dropping a file into a chat) must do nothing while the
// lock is up — the DOM under the lock is still there. Mirrors the gate's state; false when no gate is mounted.
let lockedNow = false;
/** True while the lock screen is shown (or the settings have not been read yet and a lock may follow). */
export const isLocked = () => lockedNow;

/** Mount once near the root, above everything else. */
export function LockGate() {
  const settings = useLockSettings();
  const enabled = !!settings.record;
  // The App waits for the settings before its first frame, so the start state is usually known here and no
  // open frame slips through before an effect runs. Until they are read (or when they could not be) an
  // opaque cover stands in: a read error must never open the app.
  const [ready, setReady] = useState(lockSettingsLoaded);
  const [unreadable, setUnreadable] = useState(false);
  const [locked, setLockedState] = useState(() => lockSettingsLoaded() && shouldLockOnLaunch(getLockSettings(), Date.now(), Platform.OS === 'web' ? 'web' : 'native'));
  const lockedRef = useRef(locked); lockedRef.current = locked;
  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true; setLockedState(true);
    // Locked is also what is saved: a kill-and-relaunch inside the autolock delay must not skip the code.
    void setLockSettings(LOCKED_PATCH);
  }, []);
  const load = useCallback(() => {
    setUnreadable(false);
    void loadLockSettings().then(loaded => {
      setReady(true);
      if (shouldLockOnLaunch(loaded, Date.now(), Platform.OS === 'web' ? 'web' : 'native')) lock();
    }, () => setUnreadable(true));
  }, [lock]);
  useEffect(() => { if (!ready) load(); }, [ready, load]);
  useEffect(() => { lockListeners.add(lock); return () => { lockListeners.delete(lock); }; }, [lock]);
  // App switcher privacy (iOS): the snapshot in the switcher is the app as it is, so an opaque cover goes up
  // the moment the app turns inactive while a code is set, and comes down when it is active again.
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (!enabled) { lockedRef.current = false; setLockedState(false); setCovered(false); return; }
    let wasBackground = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };
    const onChange = (state: AppStateStatus) => {
      const current = getLockSettings();
      if (state === 'active') {
        cancelGrace(); setCovered(false);
        if (!lockedRef.current && shouldLockOnReturn(current, wasBackground, Date.now())) lock();
        wasBackground = false; return;
      }
      if (state !== 'background' && state !== 'inactive') return;
      if (state === 'background') wasBackground = true;
      const action = onLeave(current, lockedRef.current, state, Platform.OS === 'ios');
      if (action.cover) setCovered(true);
      if (action.recordBackgroundAt) void setLockSettings({ backgroundAt: Date.now() });
      if (action.lock === 'now') { cancelGrace(); lock(); }
      // «Сразу» on a mere inactive (Face ID sheet, Control Centre, a system picker): a short grace first.
      else if (action.lock === 'soon' && !graceTimer) graceTimer = setTimeout(() => { graceTimer = null; lock(); }, INACTIVE_LOCK_GRACE_MS);
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => { sub.remove(); cancelGrace(); };
  }, [enabled, lock]);
  const unlock = useCallback(() => { lockedRef.current = false; setLockedState(false); void recordSuccess(); }, []);
  const showLock = enabled && locked;
  const showCover = !ready || unreadable || (enabled && covered && !locked);
  const blocking = showLock || showCover;
  useEffect(() => { lockedNow = blocking; return () => { lockedNow = false; }; }, [blocking]);
  if (!showLock && !showCover) return null;
  return <Overlay>{showLock ? <LockScreen onUnlock={unlock} /> : <Cover onRetry={unreadable ? load : undefined} />}</Overlay>;
}

/** iOS: a window-level overlay above presented modals; elsewhere a full-screen Modal. */
function Overlay({ children }: { children: React.ReactNode }) {
  if (Platform.OS === 'ios') return <FullWindowOverlay unstable_accessibilityContainerViewIsModal><View style={StyleSheet.absoluteFill}>{children}</View></FullWindowOverlay>;
  return <Modal visible transparent={false} animationType="none" statusBarTranslucent navigationBarTranslucent presentationStyle="fullScreen" onRequestClose={() => {}} supportedOrientations={['portrait', 'landscape']}>{children}</Modal>;
}

/** Opaque stand-in: while the settings are read, in the app switcher, or when the store could not be read. */
function Cover({ onRetry }: { onRetry?: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets();
  return <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', paddingTop: insets.top, paddingBottom: insets.bottom, paddingHorizontal: 28, gap: 18 }}>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}><GlassBackdrop /></View>
    <Logo size={64} />
    {onRetry ? <>
      <Text style={{ color: t.text, fontSize: 16, textAlign: 'center', lineHeight: 22 }}>Не удалось прочитать настройки код-пароля</Text>
      <Button label="Повторить" icon="refresh-outline" onPress={onRetry} />
    </> : null}
  </View>;
}

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const settings = useLockSettings();
  const record = settings.record!;
  const [shake, setShake] = useState(0); const [checking, setChecking] = useState(false); const [wrong, setWrong] = useState(false);
  const wait = useRetryWait();
  const [bio, setBio] = useState<BiometricInfo | null>(null);
  const prompting = useRef(false);
  const tryBiometric = useCallback(async () => {
    if (prompting.current) return; prompting.current = true;
    try { if (await authenticateBiometric()) { lightFeedback(); onUnlock(); } } finally { prompting.current = false; }
  }, [onUnlock]);
  // Face ID / Touch ID is offered straight away, as Telegram does, when it is on and the device has it.
  useEffect(() => {
    if (!settings.biometrics) { setBio(null); return; }
    let alive = true;
    void biometricInfo().then(info => { if (!alive) return; setBio(info.available ? info : null); if (info.available && AppState.currentState === 'active') void tryBiometric(); });
    return () => { alive = false; };
  }, [settings.biometrics, tryBiometric]);
  const submit = async (code: string) => {
    if (checking || wait > 0) return;
    setChecking(true);
    try {
      if (await checkCode(code, record)) { lightFeedback(); onUnlock(); return; }
      setWrong(true); setShake(value => value + 1);
      void recordFailure();
    } finally { setChecking(false); }
  };
  const hint = wait > 0 ? retryHint(wait) : record.kind === 'digits' ? 'Введи код-пароль, чтобы открыть Инвиз' : 'Введи пароль, чтобы открыть Инвиз';
  return <View style={{ flex: 1, backgroundColor: t.bg }}>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}><GlassBackdrop /></View>
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingTop: insets.top + 24, paddingBottom: insets.bottom + 28, paddingHorizontal: 16, gap: 28 }} keyboardShouldPersistTaps="handled" bounces={false}>
      <View style={{ alignItems: 'center', gap: 14 }}>
        <Logo size={64} />
        <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', letterSpacing: 1.6 }}>ИНВИЗ</Text>
      </View>
      <CodeEntry kind={record.kind} title={record.kind === 'digits' ? 'Введи код-пароль' : 'Введи пароль'} hint={hint} error={wrong && wait <= 0 ? 'Неверный код-пароль' : undefined} shake={shake} disabled={checking || wait > 0} onSubmit={code => void submit(code)}
        biometric={bio ? { icon: bio.label === 'Face ID' ? 'scan-outline' : 'finger-print-outline', label: bio.label, onPress: () => void tryBiometric() } : null} />
    </ScrollView>
  </View>;
}
