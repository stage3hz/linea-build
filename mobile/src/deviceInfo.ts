import { Platform } from 'react-native';
import { desktopBridge } from './desktop';
import { APP_VERSION } from './serverConfig';

/**
 * What this build tells the server about itself at sign-in («Активные сеансы», F6): platform,
 * device model, OS version and app version. Read from React Native's Platform.constants (no
 * extra native module) and the browser's user agent on web. Nothing here locates the device:
 * the server shows the request address as text only.
 */
export type DeviceInfo = {
  /** `ios` | `android` | `windows` (the desktop app) | `web`. */
  platform: string;
  /** Short name shown in the sessions list and in «Новый вход: …». */
  deviceName: string;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string;
};

type Constants = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : typeof value === 'number' && Number.isFinite(value) ? String(value) : null);

/**
 * OS name and version from a browser user agent (web only, coarse: «Windows», «macOS 14.5», «Android 14»).
 * Windows 10 and 11 both report `Windows NT 10.0` (the real version is behind Client Hints, which
 * the desktop bridge does not expose), so Windows is named without a version rather than wrongly.
 */
export function browserOs(userAgent: string): string | null {
  const ua = userAgent || '';
  let match: RegExpMatchArray | null;
  if ((match = ua.match(/Windows NT (\d+)\.(\d+)/))) return match[1] === '6' && match[2] === '3' ? 'Windows 8.1' : match[1] === '6' && match[2] === '1' ? 'Windows 7' : 'Windows';
  if ((match = ua.match(/Android (\d+(?:\.\d+)?)/))) return `Android ${match[1]}`;
  if ((match = ua.match(/(?:iPhone|iPad|CPU) OS (\d+)_(\d+)/))) return `iOS ${match[1]}.${match[2]}`;
  if ((match = ua.match(/Mac OS X (\d+)[_.](\d+)/))) return `macOS ${match[1]}.${match[2]}`;
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** Browser family for the web session name («Chrome», «Safari», …). */
export function browserName(userAgent: string): string {
  const ua = userAgent || '';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/YaBrowser/.test(ua)) return 'Яндекс Браузер';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Браузер';
}

/** Pure: builds the report from the platform, its constants and whether the desktop bridge is present. */
export function describeDevice({ os, constants, desktop, userAgent, appVersion }: { os: string; constants: Constants; desktop: boolean; userAgent?: string; appVersion: string }): DeviceInfo {
  if (desktop) {
    const osVersion = userAgent ? browserOs(userAgent) : null;
    return { platform: 'windows', deviceName: 'Windows', deviceModel: 'Компьютер с Windows', osVersion: osVersion || 'Windows', appVersion };
  }
  if (os === 'ios') {
    const idiom = text(constants.interfaceIdiom);
    const model = idiom === 'pad' ? 'iPad' : idiom === 'mac' ? 'Mac' : 'iPhone';
    const system = text(constants.systemName) || 'iOS', version = text(constants.osVersion);
    return { platform: 'ios', deviceName: model, deviceModel: model, osVersion: version ? `${system} ${version}` : system, appVersion };
  }
  if (os === 'android') {
    const brand = text(constants.Brand) || text(constants.Manufacturer), model = text(constants.Model);
    const name = model ? (brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${capitalize(brand)} ${model}` : model) : null;
    const release = text(constants.Release);
    return { platform: 'android', deviceName: name || 'Android', deviceModel: name, osVersion: release ? `Android ${release}` : 'Android', appVersion };
  }
  const browser = browserName(userAgent || '');
  return { platform: 'web', deviceName: browser, deviceModel: browser, osVersion: browserOs(userAgent || ''), appVersion };
}
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

let cached: DeviceInfo | null = null;
/** This device, computed once. Safe without a window (native) and without native constants (web). */
export function deviceInfo(): DeviceInfo {
  if (cached) return cached;
  const constants = ((Platform as unknown as { constants?: Constants }).constants || {}) as Constants;
  const userAgent = typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  cached = describeDevice({ os: Platform.OS, constants, desktop: Boolean(desktopBridge()), userAgent, appVersion: APP_VERSION });
  return cached;
}

/** The body fields `/auth/login` and `/auth/register` accept (server/src/auth.js DEVICE_FIELDS). */
export function deviceFields(info: DeviceInfo = deviceInfo()) {
  return { deviceName: info.deviceName, platform: info.platform, deviceModel: info.deviceModel ?? undefined, osVersion: info.osVersion ?? undefined, appVersion: info.appVersion };
}
