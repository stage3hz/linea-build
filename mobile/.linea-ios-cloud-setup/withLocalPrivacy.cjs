// Guards generated CNG files. It does not audit runtime code or a signed IPA.
const { withFinalizedMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
const plistModule = require('@expo/plist');
const plist = plistModule.default || plistModule;

const BLOCKED = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.PACKAGE_USAGE_STATS',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_CALENDAR',
  'android.permission.WRITE_CALENDAR',
];
const deny = message => { throw new Error(`Linea privacy guard: ${message}`); };

function checkInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('Invalid Info.plist dictionary.');
  if (Object.keys(value).some(key => key.startsWith('NSLocation'))) deny('NSLocation* declarations are forbidden.');
  if (Object.hasOwn(value, 'LSApplicationQueriesSchemes')) deny('Queries for other installed applications are forbidden.');
  for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) {
    if (Object.hasOwn(value, key) && value[key] !== false) deny(`Documents sharing requires absence or boolean false: ${key}`);
  }
  const modes = value.UIBackgroundModes;
  if (modes !== undefined && (!Array.isArray(modes) || modes.includes('location'))) deny('Location background mode is forbidden.');
}

function checkEntitlements(value, screenGroup) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('Invalid entitlements dictionary.');
  if (Object.hasOwn(value, 'keychain-access-groups')) deny('Shared keychain entitlement is forbidden.');
  const groups = value['com.apple.security.application-groups'];
  // The explicitly requested ReplayKit extension shares only its frame socket and
  // capture settings. Signal keys, tokens and the SQLCipher vault stay outside it.
  if (groups !== undefined && (!screenGroup || !Array.isArray(groups) || groups.length !== 1 || groups[0] !== screenGroup)) deny('Only the configured ReplayKit App Group is allowed.');
}

async function filesUnder(directory, depth = 0, state = { count: 0 }) {
  if (depth > 6) deny('Unexpected generated iOS directory depth.');
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (++state.count > 2000) deny('Unexpected generated iOS file count.');
    if (['Pods', 'build', '.git', '.xcodeproj', '.xcworkspace'].includes(entry.name) || entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) deny('Symlinks are not accepted in generated iOS configuration.');
    if (entry.isDirectory()) found.push(...await filesUnder(file, depth + 1, state));
    else if (entry.isFile() && (entry.name === 'Info.plist' || entry.name.endsWith('.entitlements'))) found.push(file);
  }
  return found;
}

async function readBounded(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) deny('Unexpected generated configuration file.');
  return fs.readFile(file, 'utf8');
}

function withLocalPrivacy(config) {
  if (!BLOCKED.every(permission => config.android?.blockedPermissions?.includes(permission))) deny('Required Android permission blocks are missing.');
  const screenEnabled = config.plugins?.some(p => (Array.isArray(p) ? p[0] : p) === './plugins/withScreenBroadcast');
  const screenGroup = screenEnabled ? (process.env.IOS_SCREEN_APP_GROUP || `group.${config.ios.bundleIdentifier}.screen`) : undefined;
  checkInfo(config.ios?.infoPlist || {});
  checkEntitlements(config.ios?.entitlements || {}, screenGroup);
  return withFinalizedMod(config, ['ios', async value => {
    const iosRoot = value.modRequest.platformProjectRoot;
    const properties = JSON.parse(await readBounded(path.join(iosRoot, 'Podfile.properties.json')));
    if (properties['ios.useFrameworks'] !== 'static') deny('LibSignalClient requires the configured static frameworks integration.');
    const podfile = await readBounded(path.join(iosRoot, 'Podfile'));
    if (!podfile.includes('use_frameworks!') || !podfile.includes("pod 'LibSignalClient'")) deny('Expected Swift framework/LibSignalClient Podfile integration is absent.');
    const files = await filesUnder(iosRoot);
    if (!files.some(file => path.basename(file) === 'Info.plist')) deny('Generated Info.plist was not found.');
    for (const file of files) {
      const data = plist.parse(await readBounded(file));
      if (file.endsWith('.entitlements')) checkEntitlements(data, screenGroup);
      else checkInfo(data);
    }
    return value;
  }]);
}

module.exports = withLocalPrivacy;
