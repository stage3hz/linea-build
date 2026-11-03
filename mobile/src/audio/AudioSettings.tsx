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
import { applySink, BIND_ACTIONS, comboLabel, comboOf, type BindAction, type BindEntry, type InputMode, audioPrefs, listAudioDevices, micConstraint, releaseSink, setAudioPrefs, subscribeAudio, type AudioDevice } from './devices';

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

const newId = () => Math.random().toString(36).slice(2, 10);
const pttKey = (binds: BindEntry[]) => binds.find(b => b.enabled && b.action === 'ptt' && b.combo)?.combo || '';

/** Records one key combo: press it (with Ctrl/Alt/Shift if wanted); Esc cancels. */
function useRecorder(onCombo: (combo: string) => void) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    setCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { setWaiting(false); return; }
      const combo = comboOf(e); if (!combo) return;
      onCombo(combo); setWaiting(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); setCapturing(false); };
  }, [waiting]);
  return [waiting, setWaiting] as const;
}

/** One bind: on/off, what it does, which keys, delete. Starts switched off until a key is set. */
function BindRow({ bind }: { bind: BindEntry }) {
  const t = useTheme(); const [picking, setPicking] = useState(false);
  const update = (change: Partial<BindEntry>) => setAudioPrefs({ binds: audioPrefs().binds.map(b => b.id === bind.id ? { ...b, ...change } : b) });
  const [waiting, setWaiting] = useRecorder(combo => update({ combo, enabled: true }));
  const clash = !!bind.combo && audioPrefs().binds.some(b => b.id !== bind.id && b.enabled && b.combo === bind.combo);
  return <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderColor: 'rgba(127,127,127,0.12)' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: bind.enabled }} disabled={!bind.combo} onPress={() => update({ enabled: !bind.enabled })}
        style={{ width: 40, height: 24, borderRadius: 12, padding: 3, opacity: bind.combo ? 1 : 0.4, backgroundColor: bind.enabled ? t.accent : 'rgba(127,127,127,0.35)', alignItems: bind.enabled ? 'flex-end' : 'flex-start' }}>
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFF' }} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => setPicking(p => !p)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: t.text, fontSize: 14, flexShrink: 1 }}>{BIND_ACTIONS[bind.action].label}</Text>
        <Icon name={picking ? 'chevron-up' : 'chevron-down'} size={15} color={t.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => setWaiting(w => !w)} style={{ minWidth: 118, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: waiting ? t.accent : clash ? t.danger : 'rgba(127,127,127,0.35)' }}>
        <Text style={{ color: waiting ? t.accent : bind.combo ? t.text : t.muted, fontSize: 13, fontWeight: '600' }}>{waiting ? 'Нажми клавиши…' : bind.combo ? comboLabel(bind.combo) : 'Назначить'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Удалить бинд" hitSlop={8} onPress={() => setAudioPrefs({ binds: audioPrefs().binds.filter(b => b.id !== bind.id) })}><Icon name="trash-outline" size={18} color={t.muted} /></Pressable>
    </View>
    {picking ? <View style={{ gap: 2, paddingLeft: 50 }}>
      {(Object.keys(BIND_ACTIONS) as BindAction[]).map(action => <Pressable key={action} accessibilityRole="radio" accessibilityState={{ checked: bind.action === action }} onPress={() => { update({ action }); setPicking(false); }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}>
        <Icon name={bind.action === action ? 'radio-button-on' : 'radio-button-off'} size={16} color={bind.action === action ? t.accent : t.muted} />
        <Text style={{ color: t.text, fontSize: 13 }}>{BIND_ACTIONS[action].label}</Text>
        <Text style={{ color: t.muted, fontSize: 11 }}>{BIND_ACTIONS[action].hold ? 'удержание' : 'нажатие'}</Text>
      </Pressable>)}
    </View> : null}
    {clash ? <Text style={{ color: t.danger, fontSize: 11.5, paddingLeft: 50 }}>Эти клавиши уже у другого включённого бинда — сработают оба.</Text> : null}
  </View>;
}

/**
 * Like Discord: a closed field with the current device; tap to open the list. First item is
 * always the Windows default (chosen out of the box and followed when Windows switches it).
 */
function DevicePicker({ icon, value, devices, defaultName, onChange }: { icon: 'mic' | 'headset'; value: string; devices: AudioDevice[]; defaultName: string; onChange: (id: string) => void }) {
  const t = useTheme(); const [open, setOpen] = useState(false);
  const known = !value || devices.some(d => d.id === value);
  const defaultLabel = `По умолчанию (Windows)${defaultName ? ` — ${defaultName}` : ''}`;
  const current = !value ? defaultLabel : devices.find(d => d.id === value)?.label || 'Устройство отключено — звук идёт на устройство по умолчанию';
  const pick = (id: string) => { onChange(id); setOpen(false); };
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${icon === 'mic' ? 'Микрофон' : 'Устройство вывода'}: ${current}`} onPress={() => setOpen(o => !o)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 14, backgroundColor: pressed ? 'rgba(127,127,127,0.12)' : 'transparent' })}>
      <Icon name={icon} size={18} color={t.accent} />
      <Text numberOfLines={1} style={{ flex: 1, color: known ? t.text : t.danger, fontSize: 14.5 }}>{current}</Text>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={17} color={t.muted} />
    </Pressable>
    {open ? <View style={{ marginHorizontal: 10, marginBottom: 8, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(127,127,127,0.10)' }}>
      <Choice label={defaultLabel} selected={!value} onPress={() => pick('')} />
      {devices.map(d => <Choice key={d.id} label={d.label} selected={value === d.id} onPress={() => pick(d.id)} />)}
    </View> : null}
  </View>;
}

export function AudioSettings() {
  const t = useTheme();
  const prefs = useSyncExternalStore(subscribeAudio, audioPrefs, audioPrefs);
  const [devices, setDevices] = useState<{ inputs: AudioDevice[]; outputs: AudioDevice[]; named: boolean; defaultInput: string; defaultOutput: string }>({ inputs: [], outputs: [], named: true, defaultInput: '', defaultOutput: '' });
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
      <DevicePicker icon="mic" value={prefs.input} devices={devices.inputs} defaultName={devices.defaultInput} onChange={id => setAudioPrefs({ input: id })} />
      <Switch label="Шумоподавление" description="Убирает постоянный фон: вентилятор, клавиатуру, улицу" value={prefs.noiseSuppression} onChange={v => setAudioPrefs({ noiseSuppression: v })} />
      <Switch label="Эхоподавление" description="Включи, если говоришь через колонки, а не наушники" value={prefs.echoCancellation} onChange={v => setAudioPrefs({ echoCancellation: v })} />
    </Section>
    <Section title="Режим микрофона">
      <ModePicker value={prefs.inputMode} onChange={v => setAudioPrefs({ inputMode: v })} />
      {prefs.inputMode === 'activity' ? <ThresholdBar level={level} threshold={prefs.threshold} enabled onChange={v => setAudioPrefs({ threshold: v })} /> : null}
      {prefs.inputMode === 'ptt' ? <Text style={{ color: pttKey(prefs.binds) ? t.muted : t.danger, fontSize: 12, paddingHorizontal: 14, paddingBottom: 12 }}>{pttKey(prefs.binds) ? `Зажми ${comboLabel(pttKey(prefs.binds))} — тебя слышно, пока клавиша нажата. В голосовом канале есть и кнопка «Говорить».` : 'Добавь бинд «Рация» ниже, в «Горячих клавишах», — или говори кнопкой в голосовом канале.'}</Text> : null}
    </Section>
    <Section title="Горячие клавиши">
      {prefs.binds.length ? prefs.binds.map(bind => <BindRow key={bind.id} bind={bind} />) : <Text style={{ color: t.muted, fontSize: 13, padding: 14 }}>Биндов нет. Добавь свой: выбери действие и нажми нужные клавиши.</Text>}
      <Pressable accessibilityRole="button" onPress={() => setAudioPrefs({ binds: [...prefs.binds, { id: newId(), action: 'mute', combo: '', enabled: false }] })} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, opacity: pressed ? 0.6 : 1 })}>
        <Icon name="add-circle-outline" size={19} color={t.accent} /><Text style={{ color: t.accent, fontSize: 14.5, fontWeight: '600' }}>Добавить бинд</Text>
      </Pressable>
      <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 14, paddingBottom: 12 }}>Бинды работают и поверх игр. Для «удержания» (рация, молчать) Инвиз слушает клавиатуру, только пока ты в голосовом канале или звонке, и сверяет нажатия лишь с твоими биндами — ничего не сохраняется и никуда не отправляется.</Text>
    </Section>
    <Section title="Динамики и наушники">
      {outputSupported ? <>
        <DevicePicker icon="headset" value={prefs.output} devices={devices.outputs} defaultName={devices.defaultOutput} onChange={id => setAudioPrefs({ output: id })} />
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
