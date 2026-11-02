const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

// In-app update on Android: after the APK is downloaded and its SHA-256 checked, the app
// opens the system installer. Android requires this permission for that; the user still
// confirms the installation in the system window (and allows "install from INVIZENT" once).
function withSelfUpdate(config) {
  return withAndroidManifest(config, next => {
    AndroidConfig.Permissions.ensurePermissions(next.modResults, ['android.permission.REQUEST_INSTALL_PACKAGES']);
    return next;
  });
}
module.exports = createRunOncePlugin(withSelfUpdate, 'linea-self-update', '1.0.0');
