const { createRunOncePlugin, withEntitlementsPlist } = require('expo/config-plugins');

// Sideloaded / simulator builds only (IOS_PUSH unset): expo-notifications adds the iOS
// «aps-environment» entitlement, which a sideloading certificate without Push cannot sign, so it
// is removed here. The App Store build sets IOS_PUSH=1, keeps the entitlement and registers the
// APNs token (src/push.ts); the server sends through Apple with the key from deploy/apns.sh.
function withNoIosPush(config) {
  return withEntitlementsPlist(config, next => { delete next.modResults['aps-environment']; return next; });
}
module.exports = createRunOncePlugin(withNoIosPush, 'linea-no-ios-push', '1.0.0');
