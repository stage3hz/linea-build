// Звонок › «Звук»: which microphone and which output the call uses. By default — as the system routes it
// (connected headphones take both); here the user can change that for this call.
//  - iPhone: the microphone is chosen on its own (the phone's own while the sound stays in Bluetooth headphones);
//    the output: «Громкий динамик» here, any other device in the system's list.
//  - Android: one device takes both the sound and the microphone (the system does not let an app split them).
// The names and the rules are in audioRouteModel.ts; the native side is modules/linea-call and
// react-native-incall-manager. Drawn inside the call screen (not a window of its own).
import React, { useEffect, useState } from 'react';
import { DeviceEventEmitter, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../typography';
import { Icon } from '../components';
import type { LineaCallBridge } from '../../modules/linea-call';
import { androidRouteLabel, androidRoutes, microphoneChoices, outputDevices, portHint, portLabel, type AndroidRoute, type AudioPort } from './audioRouteModel';

type Route = { inputs: AudioPort[]; input?: AudioPort; output?: AudioPort; chosen?: string; outputChoice?: 'system' | 'receiver' | 'device'; outputDevice?: string };
type Listener = { remove(): void };
let bridge: (LineaCallBridge & { addListener?(event: 'route', listener: () => void): Listener }) | null | undefined;
function native() {
  if (bridge === undefined) { try { bridge = (require('expo-modules-core') as typeof import('expo-modules-core')).requireOptionalNativeModule('LineaCall'); } catch { bridge = null; } }
  return bridge;
}

/** Whether this phone offers a choice at all (an iPhone build with the route functions, or Android). */
export const callAudioChoice = () => Platform.OS === 'android' || (Platform.OS === 'ios' && typeof native()?.audioRoute === 'function');

/** A call has ended: the next one starts on the system's own microphone again. */
export function resetCallAudio() { try { void native()?.setAudioInput?.(null)?.catch(() => {}); void native()?.setAudioOutput?.('system', null)?.catch(() => {}); } catch { /* optional */ } }

function Row({ label, hint, selected, onPress, icon }: { label: string; hint?: string; selected?: boolean; onPress: () => void; icon?: React.ComponentProps<typeof Icon>['name'] }) {
  return <Pressable accessibilityRole={selected === undefined ? 'button' : 'radio'} accessibilityState={selected === undefined ? undefined : { selected }} accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 14, borderRadius: 14, backgroundColor: pressed ? 'rgba(255,255,255,0.14)' : selected ? 'rgba(255,255,255,0.10)' : 'transparent' })}>
    {icon ? <Icon name={icon} size={20} color="#FFFFFF" /> : null}
    <View style={{ flex: 1 }}><Text style={{ color: '#FFFFFF', fontSize: 16 }}>{label}</Text>{hint ? <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{hint}</Text> : null}</View>
    {selected ? <Icon name="checkmark" size={20} color="#FFFFFF" /> : null}
  </Pressable>;
}
const Title = ({ children }: { children: string }) => <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 }}>{children}</Text>;

export function CallAudioPanel({ inCall, speakerOn, onSpeaker, onClose }: { /** react-native-incall-manager, or null. */ inCall: any; speakerOn: boolean; /** Switches «Громкий динамик». */ onSpeaker: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  // iPhone: the microphones and the current route, refreshed whenever the route changes.
  const [route, setRoute] = useState<Route | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const module = native(); if (!module?.audioRoute) return;
    const read = () => { try { setRoute(module.audioRoute!() as Route); } catch { /* keep the last one */ } };
    read();
    let subscription: Listener | null = null;
    try { subscription = module.addListener?.('route', read) ?? null; } catch { /* no events: the list is read once */ }
    // A change of microphone takes a moment to show in the route.
    const timer = setInterval(read, 1500);
    return () => { subscription?.remove(); clearInterval(timer); };
  }, []);
  // Android: the devices react-native-incall-manager sees and the one in use.
  const [devices, setDevices] = useState<{ list: AndroidRoute[]; selected: string }>({ list: [], selected: '' });
  const [system, setSystem] = useState(true);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const take = (status: any) => { if (status) setDevices({ list: androidRoutes(status.availableAudioDeviceList), selected: typeof status.selectedAudioDevice === 'string' ? status.selectedAudioDevice : '' }); };
    const subscription = DeviceEventEmitter.addListener('onAudioDeviceChanged', take);
    // A name it does not know changes nothing and answers with the current list.
    try { void Promise.resolve(inCall?.chooseAudioRoute?.('')).then(take, () => {}); } catch { /* optional */ }
    return () => subscription.remove();
  }, [inCall]);

  const chooseInput = (id: string | null) => { void native()?.setAudioInput?.(id)?.then(() => { try { setRoute(native()!.audioRoute!() as Route); } catch { /* next refresh */ } }, () => {}); };
  const chooseDevice = (device: AndroidRoute | null) => {
    setSystem(device === null);
    try { if (device === null) inCall?.setForceSpeakerphoneOn?.(null); else void Promise.resolve(inCall?.chooseAudioRoute?.(device)).catch(() => {}); } catch { /* optional */ }
  };
  // iPhone: where the call sounds. The loudspeaker is the call screen's own switch; the rest is asked of iOS.
  const reread = () => { try { setRoute(native()!.audioRoute!() as Route); } catch { /* next refresh */ } };
  const chooseOutput = (kind: 'system' | 'receiver' | 'device' | 'speaker', id: string | null = null) => {
    if (kind === 'speaker') { if (!speakerOn) onSpeaker(); return; }
    if (speakerOn) onSpeaker();
    void native()?.setAudioOutput?.(kind, id)?.then(reread, () => {});
  };
  const outputChoice = route?.outputChoice || 'system';
  const microphones = microphoneChoices(route?.inputs);
  return <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 20, justifyContent: 'flex-end' }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' }} />
    <View style={{ marginHorizontal: 10, marginBottom: insets.bottom + 10, borderRadius: 26, backgroundColor: 'rgba(28,30,38,0.97)', paddingVertical: 8, maxHeight: '72%' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 44 }}>
        <Text style={{ flex: 1, color: '#FFFFFF', fontSize: 18, fontWeight: '700' }}>Звук</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose} hitSlop={10}><Icon name="close" size={22} color="#FFFFFF" /></Pressable>
      </View>
      <ScrollView bounces={false} contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 6 }}>
        {Platform.OS === 'ios' ? <>
          <Title>Динамики</Title>
          {route?.output ? <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, paddingHorizontal: 14, paddingBottom: 4 }}>Сейчас: {portLabel(route.output)}</Text> : null}
          <Row icon="phone-portrait-outline" label="Как в системе" selected={!speakerOn && outputChoice === 'system'} onPress={() => chooseOutput('system')} />
          <Row icon="call" label="Телефон" selected={!speakerOn && outputChoice === 'receiver'} onPress={() => chooseOutput('receiver')} />
          <Row icon="volume-high" label="Громкий динамик" selected={speakerOn} onPress={() => chooseOutput('speaker')} />
          {outputDevices(route?.inputs).map(port => <Row key={port.id} icon="headset-outline" label={portLabel(port)} hint={portHint(port.kind) || undefined} selected={!speakerOn && outputChoice === 'device' && route?.outputDevice === port.id} onPress={() => chooseOutput('device', port.id)} />)}
          <Row icon="list-outline" label="Список системы…" hint="Если устройства нет выше (колонка, AirPlay)" onPress={() => { void native()?.showOutputPicker?.()?.catch(() => {}); }} />
          <Title>Микрофон</Title>
          <Row icon="mic-outline" label="Как в системе" hint={!route?.chosen && route?.input ? `Сейчас: ${portLabel(route.input)}` : undefined} selected={!route?.chosen} onPress={() => chooseInput(null)} />
          {microphones.map(port => <Row key={port.id} icon="mic" label={portLabel(port)} hint={portHint(port.kind) || undefined} selected={route?.chosen === port.id} onPress={() => chooseInput(port.id)} />)}
        </> : <>
          <Title>Устройство звука</Title>
          <Row icon="phone-portrait-outline" label="Как в системе" selected={system} onPress={() => chooseDevice(null)} />
          {devices.list.map(device => <Row key={device} icon={device === 'SPEAKER_PHONE' ? 'volume-high' : device === 'EARPIECE' ? 'call' : 'headset-outline'} label={androidRouteLabel(device)} selected={!system && devices.selected === device} onPress={() => chooseDevice(device)} />)}
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingTop: 8 }}>На Android звук и микрофон идут через одно устройство: система не даёт приложению разделить их в звонке.</Text>
        </>}
      </ScrollView>
    </View>
  </View>;
}
