// Настройки → Звук и микрофон (PC version): pick the microphone and the speakers/headphones,
// see the microphone level live and play a test sound on the chosen output.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { GlassSurface } from '../glass';
import { Icon } from '../components';
import { dbfs } from './gate';
import { setCapturing } from './binds';
import { applySink, comboLabel, comboOf, type BindAction, type InputMode, audioPrefs, listAudioDevices, micConstraint, releaseSink, setAudioPrefs, subscribeAudio, type AudioDevice } from './devices';

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 14, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontSize: 14.5 }}>{label}</Text>
    {selected ? <Icon name="checkmark" size={18} color={t.accent} /> : null}
  </Pressable>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return <View style={{ gap: 7 }}>
    <Text style={{ color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 8 }}>{title.toUpperCase()}</Text>
    <GlassSurface radius={20} shadow={false} contentStyle={{ paddingVertical: 2, overflow: 'hidden', borderRadius: 20 }}>{children}</GlassSurface>
  </View>;
}

function Switch({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
    <View style={{ flex: 1, gap: 2 }}><Text style={{ color: t.text, fontSize: 14.5 }}>{label}</Text><Text style={{ color: t.muted, fontSize: 12 }}>{description}</Text></View>
    <View style={{ width: 44, height: 26, borderRadius: 13, padding: 3, backgroundColor: value ? t.accent : 'rgba(127,127,127,0.35)', alignItems: value ? 'flex-end' : 'flex-start' }}><View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF' }} /></View>
  </Pressable>;
}

/**
 * Like Discord's input sensitivity: the live microphone level runs along the bar; drag or click
 * to set the threshold. Green part = would be sent.
 */
function ThresholdBar({ level, threshold, enabled, onChange }: { level: number; threshold: number; enabled: boolean; onChange: (db: number) => void }) {
  const t = useTheme(); const [width, setWidth] = useState(1);
  const pct = (db: number) => Math.max(0, Math.min(100, db + 100));
  const set = (x: number) => onChange(Math.round(Math.max(-100, Math.min(0, (x / width) * 100 - 100))));
  const open = !enabled || level >= threshold;
  return <View style={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: 14, gap: 6, opacity: enabled ? 1 : 0.5 }}>
    <Text style={{ color: t.muted, fontSize: 12 }}>{enabled ? `Порог: ${threshold} дБ · ${open ? 'сейчас слышно' : 'сейчас тихо — не передаётся'}` : 'Микрофон передаёт всегда'}</Text>
    <View onLayout={e => setWidth(e.nativeEvent.layout.width || 1)} onStartShouldSetResponder={() => enabled} onMoveShouldSetResponder={() => enabled}
      onResponderGrant={e => set(e.nativeEvent.locationX)} onResponderMove={e => set(e.nativeEvent.locationX)}
      accessibilityRole="adjustable" accessibilityLabel={`Порог активации голосом ${threshold} дБ`}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={e => onChange(Math.max(-100, Math.min(0, threshold + (e.nativeEvent.actionName === 'increment' ? 5 : -5))))}
      style={{ height: 22, justifyContent: 'center', cursor: enabled ? 'pointer' : 'default' } as object}>
      <View style={{ height: 8, borderRadius: 4, flexDirection: 'row', overflow: 'hidden' }}>
        <View style={{ width: `${pct(threshold)}%`, backgroundColor: 'rgba(240,160,48,0.35)' }} />
        <View style={{ flex: 1, backgroundColor: 'rgba(52,168,83,0.35)' }} />
      </View>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, height: 8, width: `${pct(level)}%`, borderRadius: 4, backgroundColor: open ? '#34A853' : '#F0A030' }} />
      {enabled ? <View pointerEvents="none" style={{ position: 'absolute', left: `${pct(threshold)}%`, marginLeft: -2, width: 4, height: 22, borderRadius: 2, backgroundColor: t.text }} /> : null}
    </View>
  </View>;
}

function ModePicker({ value, onChange }: { value: InputMode; onChange: (v: InputMode) => void }) {
  const t = useTheme();
  const items: [InputMode, string][] = [['always', 'Всегда'], ['activity', 'Голосом'], ['ptt', 'Рация']];
  return <View style={{ flexDirection: 'row', gap: 6, padding: 10 }}>
    {items.map(([id, label]) => <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: value === id }} onPress={() => onChange(id)} style={{ flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 12, backgroundColor: value === id ? t.accent : 'rgba(127,127,127,0.14)' }}>
      <Text style={{ color: value === id ? t.onAccent : t.text, fontSize: 13.5, fontWeight: '600' }}>{label}</Text>
    </Pressable>)}
  </View>;
}

/** Press «Назначить», then the key (with Ctrl/Alt/Shift if wanted). Esc cancels, Backspace clears. */
function BindRow({ action, label }: { action: BindAction; label: string }) {
  const t = useTheme(); const prefs = useSyncExternalStore(subscribeAudio, audioPrefs, audioPrefs);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    setCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { setWaiting(false); return; }
      if (e.code === 'Backspace') { setAudioPrefs({ binds: { ...audioPrefs().binds, [action]: '' } }); setWaiting(false); return; }
      const combo = comboOf(e); if (!combo) return;
      // One key, one action: taking it from another action frees it there.
      const binds = { ...audioPrefs().binds }; for (const k of Object.keys(binds) as BindAction[]) if (binds[k] === combo) binds[k] = '';
      setAudioPrefs({ binds: { ...binds, [action]: combo } }); setWaiting(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); setCapturing(false); };
  }, [waiting, action]);
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 50 }}>
    <Text style={{ flex: 1, color: t.text, fontSize: 14 }}>{label}</Text>
    <Pressable accessibilityRole="button" onPress={() => setWaiting(w => !w)} style={{ minWidth: 120, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: waiting ? t.accent : 'rgba(127,127,127,0.35)' }}>
      <Text style={{ color: waiting ? t.accent : prefs.binds[action] ? t.text : t.muted, fontSize: 13, fontWeight: '600' }}>{waiting ? 'Нажми клавишу…' : comboLabel(prefs.binds[action])}</Text>
    </Pressable>
  </View>;
}

export function AudioSettings() {
  const t = useTheme();
  const prefs = useSyncExternalStore(subscribeAudio, audioPrefs, audioPrefs);
  const [devices, setDevices] = useState<{ inputs: AudioDevice[]; outputs: AudioDevice[]; named: boolean }>({ inputs: [], outputs: [], named: true });
  const [level, setLevel] = useState(-100);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(() => { void listAudioDevices().then(setDevices).catch(() => setError('Не удалось получить список устройств.')); }, []);

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  // Live microphone level from the chosen microphone (only while this screen is open).
  useEffect(() => {
    let stream: MediaStream | null = null, ctx: AudioContext | null = null, frame = 0, alive = true;
    void navigator.mediaDevices.getUserMedia({ audio: micConstraint(true) as any }).then(s => {
      if (!alive) { s.getTracks().forEach(x => x.stop()); return; }
      stream = s; refresh(); setError('');
      ctx = new AudioContext(); const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const tick = () => { analyser.getFloatTimeDomainData(data); let sum = 0; for (const v of data) sum += v * v; setLevel(dbfs(Math.sqrt(sum / data.length))); frame = requestAnimationFrame(tick); };
      tick();
    }).catch(() => { if (alive) setError('Нет доступа к микрофону. Разреши его, чтобы выбрать и проверить.'); });
    return () => { alive = false; cancelAnimationFrame(frame); stream?.getTracks().forEach(x => x.stop()); void ctx?.close(); };
  }, [prefs.input, prefs.noiseSuppression, prefs.echoCancellation]);

  const playTest = () => {
    if (testing) return; setTesting(true);
    const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain(); gain.gain.value = 0.15; gain.connect(dest);
    // Two short notes, left then right, so the sides of headphones are easy to tell apart.
    [[523.25, -1, 0], [659.25, 1, 0.45]].forEach(([freq, pan, at]) => {
      const osc = ctx.createOscillator(); osc.frequency.value = freq; const p = ctx.createStereoPanner(); p.pan.value = pan;
      osc.connect(p).connect(gain); osc.start(ctx.currentTime + at); osc.stop(ctx.currentTime + at + 0.4);
    });
    const el = new Audio(); el.srcObject = dest.stream;
    void applySink(el).then(() => el.play()).catch(() => {});
    setTimeout(() => { el.pause(); el.srcObject = null; releaseSink(el); void ctx.close(); setTesting(false); }, 1100);
  };

  const outputSupported = typeof (HTMLMediaElement.prototype as any).setSinkId === 'function';
  return <View style={{ gap: 18 }}>
    <Section title="Микрофон">
      <Choice label="Как в системе" selected={!prefs.input} onPress={() => setAudioPrefs({ input: '' })} />
      {devices.inputs.map(d => <Choice key={d.id} label={d.label} selected={prefs.input === d.id} onPress={() => setAudioPrefs({ input: d.id })} />)}
      <Switch label="Шумоподавление" description="Убирает постоянный фон: вентилятор, клавиатуру, улицу" value={prefs.noiseSuppression} onChange={v => setAudioPrefs({ noiseSuppression: v })} />
      <Switch label="Эхоподавление" description="Включи, если говоришь через колонки, а не наушники" value={prefs.echoCancellation} onChange={v => setAudioPrefs({ echoCancellation: v })} />
    </Section>
    <Section title="Режим микрофона">
      <ModePicker value={prefs.inputMode} onChange={v => setAudioPrefs({ inputMode: v })} />
      {prefs.inputMode === 'activity' ? <ThresholdBar level={level} threshold={prefs.threshold} enabled onChange={v => setAudioPrefs({ threshold: v })} /> : null}
      {prefs.inputMode === 'ptt' ? <Text style={{ color: prefs.binds.ptt ? t.muted : t.danger, fontSize: 12, paddingHorizontal: 14, paddingBottom: 12 }}>{prefs.binds.ptt ? `Зажми ${comboLabel(prefs.binds.ptt)} — тебя слышно, пока клавиша нажата. В голосовом канале есть и кнопка «Говорить».` : 'Назначь клавишу рации ниже, в «Горячих клавишах».'}</Text> : null}
    </Section>
    <Section title="Горячие клавиши">
      <BindRow action="mute" label="Выключить / включить микрофон" />
      <BindRow action="deafen" label="Выключить / включить звук собеседников" />
      <BindRow action="ptt" label="Рация — говорить, пока зажата" />
      <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 14, paddingBottom: 12 }}>Микрофон и звук переключаются и когда Инвиз свёрнут (например, в игре). Рация работает, пока окно Инвиза активно.</Text>
    </Section>
    <Section title="Динамики и наушники">
      {outputSupported ? <>
        <Choice label="Как в системе" selected={!prefs.output} onPress={() => setAudioPrefs({ output: '' })} />
        {devices.outputs.map(d => <Choice key={d.id} label={d.label} selected={prefs.output === d.id} onPress={() => setAudioPrefs({ output: d.id })} />)}
      </> : <Text style={{ color: t.muted, padding: 14 }}>Выбор устройства вывода здесь недоступен — звук идёт на системное устройство.</Text>}
      <Pressable accessibilityRole="button" onPress={playTest} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingHorizontal: 14, opacity: pressed ? 0.7 : 1 })}>
        <Icon name={testing ? 'volume-high' : 'play-circle-outline'} size={20} color={t.accent} />
        <Text style={{ color: t.accent, fontSize: 14.5, fontWeight: '600' }}>{testing ? 'Звучит: левый, затем правый…' : 'Проверить звук'}</Text>
      </Pressable>
    </Section>
    {!devices.named ? <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 8 }}>Названия устройств появятся после разрешения доступа к микрофону.</Text> : null}
    {error ? <Text style={{ color: t.danger, fontSize: 13, paddingHorizontal: 8 }}>{error}</Text> : null}
    <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 8 }}>Звук микрофона идёт как его даёт компьютер: без автоусиления и другой обработки — только то, что включено выше. Действует в звонках и голосовых каналах; если устройство отключить, Инвиз перейдёт на системное.</Text>
  </View>;
}
