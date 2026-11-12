// Where this device's session key lives (see deviceProof.ts for what it is used for):
//  - PC: the desktop shell — the TPM, or its vault where there is no chip (desktop/devicekey.cjs);
//  - iPhone / Android: the Secure Enclave / the Android Keystore (modules/linea-signal, DeviceKey);
//  - a browser, or a build from before the key existed: none — sessions stay as they were.
import { Platform } from 'react-native';
import { desktopBridge } from './desktop';
import type { DeviceKey } from './deviceProof';
import type { LineaSignalBridge } from '../modules/linea-signal';

let native: LineaSignalBridge | null | undefined;

export function deviceKey(): DeviceKey | null {
  const desktop = desktopBridge();
  if (desktop) return desktop.deviceKey ? { ensure: () => desktop.deviceKey!.ensure(), sign: message => desktop.deviceKey!.sign(message) } : null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  // Loaded here, not imported at the top: api.ts is also loaded by the Node tests, which have no native modules.
  if (native === undefined) { try { native = (require('expo-modules-core') as typeof import('expo-modules-core')).requireOptionalNativeModule<LineaSignalBridge>('LineaSignal'); } catch { native = null; } }
  const bridge = native;
  if (!bridge || typeof bridge.deviceKeyEnsure !== 'function' || typeof bridge.deviceKeySign !== 'function') return null;
  return { ensure: () => bridge.deviceKeyEnsure!(), sign: message => bridge.deviceKeySign!(message) };
}
