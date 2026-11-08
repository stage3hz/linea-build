// F2/F4 push: the notification handler (sound per kind, «без звука» never sounds), the Android channels
// the server names (messages / calls / silent) and the preferences being read at import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';

const storage = new Map();
const reads = [];
let handler = null;
const channels = new Map();
let appState = 'background';
const mod = loadTs(new URL('../src/push.ts', import.meta.url), {
  react: { useEffect: () => {}, useRef: v => ({ current: v }), useSyncExternalStore: (_s, get) => get() },
  'react-native': { Platform: { OS: 'android' }, AppState: { get currentState() { return appState; }, addEventListener: () => ({ remove() {} }) } },
  'expo-notifications': {
    setNotificationHandler: ({ handleNotification }) => { handler = handleNotification; },
    setNotificationChannelAsync: async (id, channel) => { channels.set(id, channel); },
    AndroidImportance: { LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
    AndroidNotificationVisibility: { PRIVATE: 0, PUBLIC: 1 },
  },
  '@react-native-async-storage/async-storage': {
    getItem: async k => { reads.push(k); return storage.get(k) ?? null; },
    setItem: async (k, v) => { storage.set(k, v); }, removeItem: async k => { storage.delete(k); },
  },
});
const prefs = loadTs(new URL('../src/notifications/prefs.ts', import.meta.url), {
  react: { useSyncExternalStore: (_s, get) => get() },
  '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
});
const notification = kind => ({ request: { content: { data: { kind } } } });

test('the saved switches are read at import, before the first notification of a cold start', () => {
  assert.ok(reads.includes('linea.notification-prefs.v1'), 'AsyncStorage was asked for the preferences at import');
  assert.equal(typeof handler, 'function', 'the handler is installed on Android');
});

test('a message sounds, a «silent» message is shown but never sounds, a call always rings', async () => {
  appState = 'background';
  const message = await handler(notification('message'));
  assert.deepEqual(message, { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });
  const silent = await handler(notification('silent'));
  assert.deepEqual(silent, { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
  const call = await handler(notification('call'));
  assert.equal(call.shouldPlaySound, true);
  appState = 'active';
  assert.equal((await handler(notification('message'))).shouldShowBanner, false, 'the socket already shows what arrives while the app is open');
});

test('Android channels: messages (high, sound), calls (max), silent (low, no sound, no vibration)', async () => {
  await mod.channels();
  assert.deepEqual([...channels.keys()].sort(), ['calls', 'messages', 'silent']);
  assert.equal(channels.get('messages').importance, 4); assert.equal(channels.get('messages').sound, 'default');
  assert.equal(channels.get('calls').importance, 5);
  const silent = channels.get('silent');
  assert.equal(silent.name, 'Без звука');
  assert.equal(silent.importance, 2);
  assert.equal(silent.sound, null);
  assert.equal(silent.enableVibrate, false);
  assert.deepEqual(silent.vibrationPattern, [0]);
});

test('pushStatusText: a short Russian line for Settings, nothing while everything works', () => {
  assert.equal(mod.pushStatusText('on'), '');
  assert.match(mod.pushStatusText('denied'), /системы/);
  assert.equal(typeof prefs.loadNotificationPrefs, 'function');
});
