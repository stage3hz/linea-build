// The call's sound (звонок › «Звук»): names and choices for the microphones and outputs a phone offers.
// Pure — the screen is CallAudioPanel.tsx, the native side is modules/linea-call (iPhone) and
// react-native-incall-manager (Android).
//
// What each system allows:
//  - iPhone: any microphone can be chosen on its own (the phone's while the sound stays in Bluetooth headphones);
//    the output is chosen in the system's own list, plus «Громкий динамик» here.
//  - Android: one «устройство» takes both the sound and the microphone (the phone, the speaker, a Bluetooth or
//    wired headset) — the system has no way for an app to split them in a call.

export type AudioPort = { id: string; name: string; kind: string };

/** A microphone or an output as the user reads it. `kind`: AVAudioSession port type (the `AVAudioSessionPort` prefix
 *  is not part of the raw value: «MicrophoneBuiltIn», «BluetoothHFP», …). */
export function portLabel(port: Pick<AudioPort, 'name' | 'kind'>): string {
  switch (port.kind) {
    case 'MicrophoneBuiltIn': return 'Микрофон телефона';
    case 'Receiver': return 'Телефон';
    case 'Speaker': return 'Громкий динамик';
    case 'MicrophoneWired': case 'Headphones': case 'HeadsetMic': return port.name && !/^(headphones|headset microphone|наушники)$/i.test(port.name) ? port.name : 'Проводные наушники';
    default: return port.name || 'Устройство';
  }
}
/** A line under the name: what kind of device it is. */
export function portHint(kind: string): string {
  if (kind.startsWith('Bluetooth')) return 'Bluetooth';
  if (kind === 'USBAudio') return 'USB';
  if (kind === 'CarAudio') return 'Автомобиль';
  if (kind === 'MicrophoneWired' || kind === 'Headphones' || kind === 'HeadsetMic') return 'Провод';
  return '';
}

export type AndroidRoute = 'EARPIECE' | 'SPEAKER_PHONE' | 'BLUETOOTH' | 'WIRED_HEADSET';
const ANDROID_ROUTES: Record<AndroidRoute, string> = { EARPIECE: 'Телефон', SPEAKER_PHONE: 'Громкий динамик', BLUETOOTH: 'Bluetooth-наушники', WIRED_HEADSET: 'Проводные наушники' };
export const androidRouteLabel = (route: string): string => ANDROID_ROUTES[route as AndroidRoute] || route;

/** react-native-incall-manager reports the list as a JSON string (`availableAudioDeviceList`) or, in older
 *  versions, as an array. Unknown names are dropped; the order is the one people expect. */
export function androidRoutes(list: unknown): AndroidRoute[] {
  let names: unknown = list;
  if (typeof list === 'string') { try { names = JSON.parse(list); } catch { names = []; } }
  const known = Array.isArray(names) ? names.filter((name): name is AndroidRoute => typeof name === 'string' && name in ANDROID_ROUTES) : [];
  return (['BLUETOOTH', 'WIRED_HEADSET', 'EARPIECE', 'SPEAKER_PHONE'] as const).filter(route => known.includes(route));
}

/** The microphones to offer: each once, the phone's own first. */
export function microphoneChoices(inputs: readonly AudioPort[] | undefined): AudioPort[] {
  const seen = new Set<string>(), result: AudioPort[] = [];
  for (const port of inputs || []) { if (!port || typeof port.id !== 'string' || !port.id || seen.has(port.id)) continue; seen.add(port.id); result.push(port); }
  return result.sort((a, b) => Number(b.kind === 'MicrophoneBuiltIn') - Number(a.kind === 'MicrophoneBuiltIn'));
}
