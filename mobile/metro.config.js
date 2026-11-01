// Animated emoji (Lottie JSON) ship as assets (.ljson), not as JS modules, so they
// are not parsed at startup; each one loads from disk only when it is shown.
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('ljson');
const path = require('node:path');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'expo-file-system/legacy') return { type: 'sourceFile', filePath: path.join(__dirname, 'src/desktopFs.web.ts') };
  if (platform === 'web' && moduleName === 'react-native-webrtc') return { type: 'sourceFile', filePath: path.join(__dirname, 'src/rtc.web.tsx') };
  if (platform === 'web' && moduleName === 'react-native-incall-manager') return { type: 'sourceFile', filePath: path.join(__dirname, 'src/inCall.web.ts') };
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
