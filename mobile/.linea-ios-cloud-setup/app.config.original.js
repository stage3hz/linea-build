const development = process.env.APP_ENV !== 'production';
const allowDevelopmentHttp = development && process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP === '1';
const apiUrl = process.env.EXPO_PUBLIC_API_URL || '';

if (!development && !/^https:\/\//i.test(apiUrl)) {
  throw new Error('Production requires an HTTPS EXPO_PUBLIC_API_URL. Set the API address before building.');
}

module.exports = {
  expo: {
    name: 'Линия',
    slug: 'linea-messenger',
    version: '0.5.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    scheme: 'linea',
    userInterfaceStyle: 'automatic',
    backgroundColor: '#080F1E',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#080F1E',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: development ? 'com.linea.messenger.preview' : 'com.linea.messenger',
      infoPlist: {
        NSLocalNetworkUsageDescription: 'Подключение к вашему серверу мессенджера в локальной сети.',
        ...(allowDevelopmentHttp ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } } : {}),
      },
    },
    android: {
      package: development ? 'com.linea.messenger.preview' : 'com.linea.messenger',
      versionCode: 5,
      softwareKeyboardLayoutMode: 'resize',
      allowBackup: false,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0B1530',
      },
      blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA','android.permission.ACCESS_MEDIA_LOCATION','android.permission.WRITE_EXTERNAL_STORAGE','android.permission.READ_MEDIA_AUDIO'],
    },
    web: { bundler: 'metro', favicon: './assets/favicon.png', name: 'Линия' },
    plugins: [
      './plugins/withLineSignal',
      './plugins/withLinePhoto',
      './plugins/withLineVideo',
      'expo-font',
      'expo-asset',
      ['expo-audio', {
        microphonePermission: false,
        recordAudioAndroid: false,
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
      }],
      ['expo-secure-store', { configureAndroidBackup: true }],
      ['expo-sqlite', { useSQLCipher: true, enableFTS: false }],
      ['expo-image-picker', {
        photosPermission: 'Выберите фотографию для отправки в чат или профиля.',
        cameraPermission: false,
        microphonePermission: false,
      }],
      ['expo-media-library',{
        photosPermission:'Выберите фото и видео для вложения в сообщение.',
        savePhotosPermission:false,
        granularPermissions:['photo','video'],
        isAccessMediaLocationEnabled:false,
        preventAutomaticLimitedAccessAlert:true,
      }],
      ['expo-build-properties', { android: { usesCleartextTraffic: allowDevelopmentHttp } }],
    ],
  },
};
