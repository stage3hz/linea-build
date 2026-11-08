import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

// F6 «Активные сеансы»: what the app reports about itself at sign-in, and the «Новый вход» store.

const deviceModule = (os, constants = {}, { desktop = false } = {}) => loadTs(new URL('../src/deviceInfo.ts', import.meta.url), {
  'react-native': { Platform: { OS: os, constants } },
  './desktop': { desktopBridge: () => (desktop ? {} : undefined) },
  './serverConfig': { APP_VERSION: '0.14.13' },
});

test('iPhone and iPad report model, system version and the app version', () => {
  const { describeDevice, deviceFields } = deviceModule('ios');
  const phone = describeDevice({ os: 'ios', constants: { interfaceIdiom: 'phone', systemName: 'iOS', osVersion: '18.1' }, desktop: false, appVersion: '0.14.13' });
  assert.deepEqual(phone, { platform: 'ios', deviceName: 'iPhone', deviceModel: 'iPhone', osVersion: 'iOS 18.1', appVersion: '0.14.13' });
  const pad = describeDevice({ os: 'ios', constants: { interfaceIdiom: 'pad', systemName: 'iPadOS', osVersion: '17.6' }, desktop: false, appVersion: '0.14.13' });
  assert.equal(pad.deviceModel, 'iPad'); assert.equal(pad.osVersion, 'iPadOS 17.6');
  assert.deepEqual(deviceFields(phone), { deviceName: 'iPhone', platform: 'ios', deviceModel: 'iPhone', osVersion: 'iOS 18.1', appVersion: '0.14.13' });
});

test('Android joins brand and model and names the Android release', () => {
  const { describeDevice } = deviceModule('android');
  const pixel = describeDevice({ os: 'android', constants: { Brand: 'google', Model: 'Pixel 8', Release: '15' }, desktop: false, appVersion: '0.14.13' });
  assert.deepEqual(pixel, { platform: 'android', deviceName: 'Google Pixel 8', deviceModel: 'Google Pixel 8', osVersion: 'Android 15', appVersion: '0.14.13' });
  const samsung = describeDevice({ os: 'android', constants: { Brand: 'samsung', Model: 'SAMSUNG SM-S918B', Release: '14' }, desktop: false, appVersion: '0.14.13' });
  assert.equal(samsung.deviceModel, 'SAMSUNG SM-S918B', 'the brand is not repeated');
  const bare = describeDevice({ os: 'android', constants: {}, desktop: false, appVersion: '0.14.13' });
  assert.deepEqual(bare, { platform: 'android', deviceName: 'Android', deviceModel: null, osVersion: 'Android', appVersion: '0.14.13' }, 'no constants (tests, odd builds) is not an error');
});

test('the Windows app and browsers are told apart; the browser OS comes from the user agent', () => {
  const { describeDevice, browserOs, browserName } = deviceModule('web');
  const windows = describeDevice({ os: 'web', constants: {}, desktop: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Electron/33', appVersion: '0.14.13' });
  assert.deepEqual(windows, { platform: 'windows', deviceName: 'Windows', deviceModel: 'Компьютер с Windows', osVersion: 'Windows', appVersion: '0.14.13' }, 'Windows 10 and 11 share «Windows NT 10.0», so no version is claimed');
  assert.equal(browserOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0'), 'Windows');
  assert.equal(browserOs('Mozilla/5.0 (Windows NT 6.3; Win64; x64) Chrome/109.0'), 'Windows 8.1');
  assert.equal(browserOs('Mozilla/5.0 (Windows NT 6.1; WOW64) Firefox/115.0'), 'Windows 7');
  const chrome = describeDevice({ os: 'web', constants: {}, desktop: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', appVersion: '0.14.13' });
  assert.deepEqual(chrome, { platform: 'web', deviceName: 'Chrome', deviceModel: 'Chrome', osVersion: 'macOS 14.5', appVersion: '0.14.13' });
  assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0'), 'Firefox');
  assert.equal(browserOs('Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0'), 'Linux');
  assert.equal(browserOs('Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130'), 'Android 14');
  assert.equal(browserOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'), 'iOS 18.0');
  assert.equal(browserOs(''), null);
  assert.equal(describeDevice({ os: 'web', constants: {}, desktop: false, userAgent: '', appVersion: '1' }).deviceName, 'Браузер');
});

test('deviceInfo() works without native constants and without a window, and is computed once', () => {
  const { deviceInfo } = deviceModule('android');
  const first = deviceInfo();
  assert.equal(first.platform, 'android');
  assert.equal(deviceInfo(), first);
});

test('«Новый вход»: only session.new packets are kept, newest first, without duplicates, and can be dismissed', () => {
  const alerts = loadTs(new URL('../src/sessionAlerts.ts', import.meta.url), { react: { useSyncExternalStore: (_s, get) => get() } });
  let clock = 1000;
  const now = () => clock;
  assert.equal(alerts.noteSocketEvent({ type: 'message', message: {} }, now), false);
  assert.equal(alerts.noteSocketEvent({ type: 'session.new' }, now), false, 'a packet without a session is ignored');
  assert.equal(alerts.noteSocketEvent({ type: 'session.new', session: { id: 'a', deviceName: 'Windows', deviceModel: 'Windows PC', osVersion: 'Windows 11', createdAt: '2026-11-08T10:00:00Z', lastActiveAt: '', expiresAt: '', isCurrent: false }, label: 'Windows PC · Windows 11' }, now), true);
  clock = 2000;
  assert.equal(alerts.noteSocketEvent({ type: 'session.new', session: { id: 'b', deviceName: 'Браузер', createdAt: '', lastActiveAt: '', expiresAt: '', isCurrent: false } }, now), true);
  let logins = alerts.getLogins();
  assert.deepEqual(logins.map(login => [login.session.id, login.label, login.receivedAt]), [['b', 'Браузер', 2000], ['a', 'Windows PC · Windows 11', 1000]], 'the label falls back to the device name');
  alerts.noteSocketEvent({ type: 'session.new', session: { id: 'a', deviceName: 'Windows', deviceModel: 'Windows PC', osVersion: 'Windows 11', createdAt: '', lastActiveAt: '', expiresAt: '', isCurrent: false } }, now);
  assert.deepEqual(alerts.getLogins().map(login => login.session.id), ['a', 'b'], 'the same session is not shown twice');
  alerts.dismissLogin('a');
  assert.deepEqual(alerts.getLogins().map(login => login.session.id), ['b']);
  alerts.dismissLogin('zzz');
  assert.equal(alerts.getLogins().length, 1);
  alerts.clearLogins();
  assert.equal(alerts.useNewLogins().length, 0);
  assert.equal(alerts.loginLabel({ id: 'x', deviceName: 'Android', deviceModel: 'Pixel 8', osVersion: 'Android 15' }), 'Pixel 8 · Android 15');
  assert.equal(alerts.loginLabel({ id: 'x', deviceName: '' }), 'Неизвестное устройство');
});
