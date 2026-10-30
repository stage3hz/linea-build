// Animated emoji (Lottie JSON) ship as assets (.ljson), not as JS modules, so they
// are not parsed at startup; each one loads from disk only when it is shown.
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('ljson');
module.exports = config;
