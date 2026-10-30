const { createRunOncePlugin, withEntitlementsPlist } = require('expo/config-plugins');

// Push notifications are Android-only for now (Firebase). expo-notifications adds the iOS
// «aps-environment» entitlement, which a sideloading certificate without Push cannot sign,
// so it is removed until iOS push (APNs) is set up.
function withNoIosPush(config) {
  return withEntitlementsPlist(config, next => { delete next.modResults['aps-environment']; return next; });
}
module.exports = createRunOncePlugin(withNoIosPush, 'linea-no-ios-push', '1.0.0');
