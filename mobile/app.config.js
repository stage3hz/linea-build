// Linea iOS cloud setup v1: {"appVersion":"0.7.0"}
const development = process.env.APP_ENV !== 'production';
const allowDevelopmentHttp = development && process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP === '1';
const apiUrl = process.env.EXPO_PUBLIC_API_URL || '';

if (!development && !/^https:\/\//i.test(apiUrl)) {
  throw new Error('Production requires an HTTPS EXPO_PUBLIC_API_URL. Set the API address before building.');
}

module.exports = {
  expo: {
    name: 'INVIZENT',
    slug: 'linea-messenger',
    version: "0.7.0",
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
      versionCode: 15,
      softwareKeyboardLayoutMode: 'resize',
      allowBackup: false,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#07070A',
      },
      blockedPermissions: ["android.permission.ACCESS_MEDIA_LOCATION","android.permission.WRITE_EXTERNAL_STORAGE","android.permission.READ_MEDIA_AUDIO","android.permission.ACCESS_COARSE_LOCATION","android.permission.ACCESS_FINE_LOCATION","android.permission.ACCESS_BACKGROUND_LOCATION","android.permission.SYSTEM_ALERT_WINDOW","android.permission.QUERY_ALL_PACKAGES","android.permission.PACKAGE_USAGE_STATS","android.permission.MANAGE_EXTERNAL_STORAGE","android.permission.READ_CONTACTS","android.permission.WRITE_CONTACTS","android.permission.READ_CALENDAR","android.permission.WRITE_CALENDAR"],
    },
    web: { bundler: 'metro', favicon: './assets/favicon.png', name: 'INVIZENT' },
    plugins: [
      './plugins/withLineSignal',
      './plugins/withLinePhoto',
      './plugins/withLineVideo',
      // Montserrat (SIL OFL 1.1), embedded natively; family 'Montserrat' with weights 400–800.
      ['expo-font', {
        ios: { fonts: ['./assets/fonts/Montserrat-Regular.ttf','./assets/fonts/Montserrat-Medium.ttf','./assets/fonts/Montserrat-SemiBold.ttf','./assets/fonts/Montserrat-Bold.ttf','./assets/fonts/Montserrat-ExtraBold.ttf'] },
        android: { fonts: [{ fontFamily: 'Montserrat', fontDefinitions: [{path:'./assets/fonts/Montserrat-Regular.ttf',weight:400},{path:'./assets/fonts/Montserrat-Medium.ttf',weight:500},{path:'./assets/fonts/Montserrat-SemiBold.ttf',weight:600},{path:'./assets/fonts/Montserrat-Bold.ttf',weight:700},{path:'./assets/fonts/Montserrat-ExtraBold.ttf',weight:800}] }] },
      }],
      'expo-asset',
      ['expo-audio', {
        microphonePermission: 'Инвиз использует микрофон только во время записи голосового сообщения. Запись шифруется до отправки.',
        recordAudioAndroid: true,
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
      }],
      ['expo-camera', { cameraPermission: 'Камера нужна для видеосообщений. Видео шифруется до отправки.', microphonePermission: 'Инвиз использует микрофон только во время записи голосового или видеосообщения. Запись шифруется до отправки.', recordAudioAndroid: true }],
      ['expo-secure-store', { configureAndroidBackup: true }],
      ['expo-sqlite', { useSQLCipher: true, enableFTS: false }],
      ['expo-image-picker', {
        photosPermission: 'Выберите фотографию для отправки в чат или профиля.',
        cameraPermission: 'Камера нужна для видеосообщений. Видео шифруется до отправки.',
        microphonePermission: 'Инвиз использует микрофон только во время записи голосового сообщения. Запись шифруется до отправки.',
      }],
      ['expo-media-library',{
        photosPermission:'Выберите фото и видео для вложения в сообщение.',
        savePhotosPermission:false,
        granularPermissions:['photo','video'],
        isAccessMediaLocationEnabled:false,
        preventAutomaticLimitedAccessAlert:true,
      }],
      ['expo-build-properties', { android: { usesCleartextTraffic: allowDevelopmentHttp }, ios: { useFrameworks: 'static' } }],
      // Alternate app icons (Настройки → Оформление → Иконка приложения).
      ['expo-alternate-app-icons', [
        { name: 'Light', ios: './assets/icons/light.png', android: { foregroundImage: './assets/icons/light-android.png', backgroundColor: '#F5F4F9' } },
        { name: 'Outline', ios: './assets/icons/outline.png', android: { foregroundImage: './assets/icons/outline-android.png', backgroundColor: '#0C0C0E' } },
        { name: 'Aurora', ios: './assets/icons/aurora.png', android: { foregroundImage: './assets/icons/aurora-android.png', backgroundColor: '#162563' } },
      ]],
      './.linea-ios-cloud-setup/withLocalPrivacy.cjs',
    ],
  },
};
