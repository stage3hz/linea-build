const { withAndroidManifest, createRunOncePlugin } = require('expo/config-plugins');

// Messages without internet (modules/linea-nearby). Only the Android 12+ «Nearby devices»
// permissions, all marked neverForLocation: Bluetooth search is never used to find out where
// someone is, so no location permission is requested (and location stays in blockedPermissions).
const NEARBY = [
  { name: 'android.permission.BLUETOOTH_SCAN', flags: 'neverForLocation' },
  { name: 'android.permission.BLUETOOTH_CONNECT' },
  { name: 'android.permission.BLUETOOTH_ADVERTISE' },
];
// Android 11 and older would need location access for Bluetooth search: the feature is off there,
// and the old Bluetooth permissions are limited to those versions only for the radio state.
const LEGACY = ['android.permission.BLUETOOTH', 'android.permission.BLUETOOTH_ADMIN'];

function withLineNearby(config) {
  return withAndroidManifest(config, value => {
    const manifest = value.modResults.manifest;
    manifest.$ = { ...manifest.$, 'xmlns:tools': manifest.$?.['xmlns:tools'] || 'http://schemas.android.com/tools' };
    const list = (manifest['uses-permission'] || []).filter(p => ![...NEARBY.map(n => n.name), ...LEGACY].includes(p.$?.['android:name']));
    for (const p of NEARBY) list.push({ $: { 'android:name': p.name, ...(p.flags ? { 'android:usesPermissionFlags': p.flags } : {}), 'tools:targetApi': 's' } });
    for (const name of LEGACY) list.push({ $: { 'android:name': name, 'android:maxSdkVersion': '30' } });
    manifest['uses-permission'] = list;
    const features = (manifest['uses-feature'] || []).filter(f => f.$?.['android:name'] !== 'android.hardware.bluetooth_le');
    features.push({ $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } });
    manifest['uses-feature'] = features;
    return value;
  });
}
module.exports = createRunOncePlugin(withLineNearby, 'linea-nearby', '0.1.0');
module.exports.NEARBY = NEARBY;
