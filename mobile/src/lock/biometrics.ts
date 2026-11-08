// Face ID / Touch ID / fingerprint through expo-local-authentication. The package ships a web build
// (no hardware → «no biometrics»), so it is imported directly; the settings hide the switch when the
// device has nothing enrolled.
import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricInfo = { available: boolean; label: string };
/** `label` is what the switch and the pad button are called: «Face ID», «Touch ID» or «биометрия». */
export const NO_BIOMETRICS: BiometricInfo = { available: false, label: 'Биометрия' };

export async function biometricInfo(): Promise<BiometricInfo> {
  if (Platform.OS === 'web') return NO_BIOMETRICS;
  try {
    const [hardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync().catch(() => [] as LocalAuthentication.AuthenticationType[]),
    ]);
    if (!hardware || !enrolled) return NO_BIOMETRICS;
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    const label = Platform.OS === 'ios' ? (face ? 'Face ID' : finger ? 'Touch ID' : 'Биометрия') : finger && !face ? 'Отпечаток пальца' : 'Биометрия';
    return { available: true, label };
  } catch { return NO_BIOMETRICS; }
}

/** True once the system confirmed the owner. The device passcode is never accepted instead (the app has its own code). */
export async function authenticateBiometric(prompt = 'Разблокировать Инвиз'): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: 'Отмена', disableDeviceFallback: true });
    return result.success === true;
  } catch { return false; }
}
