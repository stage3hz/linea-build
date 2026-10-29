const { createRunOncePlugin } = require('expo/config-plugins');

// System media APIs need no extra permissions, service, model or network SDK.
// Local Expo module discovery registers LineaVideo from expo-module.config.json.
function withLineVideo(config) { return config; }
module.exports = createRunOncePlugin(withLineVideo, 'linea-video', '0.5.0');
