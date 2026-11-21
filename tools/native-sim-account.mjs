// Registers the test account the native apps sign in to on the LOCAL test server of a CI run
// (native-ios-sim.yml / native-android-emu.yml). Uses the app's own request code (mobile/src/api.ts), the way
// tools/sim-seed.mjs does. Never talks to anything but the address given (http://127.0.0.1:<port>).
//   node tools/native-sim-account.mjs <base url> <login> <public @username>
const [base, login, handle] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '') || !/^[A-Za-z0-9_]{3,24}$/.test(login || '') || !handle) { console.error('usage: native-sim-account.mjs http://127.0.0.1:<port> <login> <handle>'); process.exit(2); }
const root = new URL('../', import.meta.url);
const { loadTs } = await import(new URL('mobile/test/support/load-ts.mjs', root));
const { Api } = loadTs(new URL('mobile/src/api.ts', root).pathname, {
  'react-native': { Platform: { OS: 'ios' } }, 'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } get size() { return 0; } } }, 'expo-file-system/legacy': {}, 'expo-sharing': {},
});
// Made-up secrets of a made-up account that lives for one CI run.
export const PASSWORD = 'Synthetic!Native.42', CONFIRMATION = 'ambergardenprism', RECOVERY = 'silverharborlantern';
const session = await new Api(base).register(login, PASSWORD, 'Проверка', CONFIRMATION, RECOVERY, handle);
console.log(JSON.stringify({ id: session.user.id, login, handle, password: PASSWORD, word: CONFIRMATION }));
