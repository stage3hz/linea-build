// Linea iOS cloud setup v1: {"appVersion":"0.14.2"}
const development = process.env.APP_ENV !== 'production';
const allowDevelopmentHttp = development && process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP === '1';
const apiUrl = process.env.EXPO_PUBLIC_API_URL || '';
const androidPackage = development ? 'com.linea.messenger.preview' : 'com.linea.messenger';

// Firebase Cloud Messaging (Android push). One google-services.json may list several Android apps;
// the Gradle plugin picks the client whose package_name matches, so the release package must be
// registered in the same Firebase project as the preview one. GOOGLE_SERVICES_FILE points CI at a
// file outside the repository; ANDROID_PUSH=0 knowingly builds an APK without push.
const googleServicesFile = process.env.GOOGLE_SERVICES_FILE || './google-services.json';
const androidPush = process.env.ANDROID_PUSH !== '0';
if (androidPush) {
  const file = require('node:path').resolve(__dirname, googleServicesFile);
  let packages = [];
  try { packages = (JSON.parse(require('node:fs').readFileSync(file, 'utf8')).client || []).map(client => client.client_info?.android_client_info?.package_name); } catch { /* reported below */ }
  // Only a warning here (this config is also evaluated for iOS builds); the Android Gradle build then stops with
  // «No matching client found for package name», instead of shipping an APK whose push silently never works.
  if (!packages.includes(androidPackage)) console.warn(`[push] ${googleServicesFile} не содержит Android-приложение ${androidPackage}: Android-сборка упадёт. Добавь этот package в проект Firebase и обнови файл, либо ANDROID_PUSH=0 для сборки без уведомлений (см. docs/BUILD.md).`);
}

if (!development && !/^https:\/\//i.test(apiUrl)) {
  throw new Error('Production requires an HTTPS EXPO_PUBLIC_API_URL. Set the API address before building.');
}

module.exports = {
  expo: {
    name: 'INVIZENT',
    slug: 'linea-messenger',
    version: "0.14.15",
    // The commit this build was made from (CI sets GITHUB_SHA): shown in Settings next to the version.
    extra: { commit: (process.env.GITHUB_SHA || "").slice(0, 7) },
    orientation: 'portrait',
    // Default icon: white outline N on black («Контур»). The blue one is an alternate.
    icon: './assets/icons/outline.png',
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
      // App Store build: the Bundle ID registered in the owner's Apple Developer account (IOS_BUNDLE_ID),
      // build number from CI (IOS_BUILD_NUMBER, must grow with every upload).
      bundleIdentifier: development ? 'com.linea.messenger.preview' : (process.env.IOS_BUNDLE_ID || 'com.invizent.app'),
      ...(process.env.IOS_BUILD_NUMBER ? { buildNumber: process.env.IOS_BUILD_NUMBER } : {}),
      infoPlist: {
        NSLocalNetworkUsageDescription: 'Чтобы писать без интернета тем, кто рядом, и подключаться к серверу мессенджера в вашей сети.',
        NSBluetoothAlwaysUsageDescription: 'Bluetooth нужен, чтобы писать без интернета тем, кто рядом. Сообщения остаются зашифрованными, местоположение не определяется.',
        // Music keeps playing and a call keeps its audio when the app goes to the background.
        // bluetooth-*: Mesh keeps passing messages with the app in the background (no internet only).
        // No 'voip': since iOS 13 it requires PushKit (every VoIP push must report a CallKit call), which the app
        // does not have yet (App Review rejects an unused mode). Incoming calls with the app closed arrive as a
        // regular APNs alert. CallKit itself is used (modules/linea-call) only for a call already running in the
        // app — placed, or answered in the app — which needs neither PushKit nor 'voip': it gives the green call
        // pill / Dynamic Island indicator in the background; the audio session keeps the call alive ('audio').
        UIBackgroundModes: ['audio', 'bluetooth-central', 'bluetooth-peripheral'],
        ...(allowDevelopmentHttp ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } } : {}),
      },
    },
    android: {
      package: androidPackage,
      versionCode: 39,
      softwareKeyboardLayoutMode: 'resize',
      // Firebase Cloud Messaging (push) in every build, see the check above.
      ...(androidPush ? { googleServicesFile } : {}),
      allowBackup: false,
      adaptiveIcon: {
        foregroundImage: './assets/icons/outline-android.png',
        backgroundColor: '#0C0C0E',
      },
      blockedPermissions: ["android.permission.ACCESS_MEDIA_LOCATION","android.permission.WRITE_EXTERNAL_STORAGE","android.permission.READ_MEDIA_AUDIO","android.permission.ACCESS_COARSE_LOCATION","android.permission.ACCESS_FINE_LOCATION","android.permission.ACCESS_BACKGROUND_LOCATION","android.permission.SYSTEM_ALERT_WINDOW","android.permission.QUERY_ALL_PACKAGES","android.permission.PACKAGE_USAGE_STATS","android.permission.MANAGE_EXTERNAL_STORAGE","android.permission.READ_CONTACTS","android.permission.WRITE_CONTACTS","android.permission.READ_CALENDAR","android.permission.WRITE_CALENDAR","android.permission.ACTIVITY_RECOGNITION"],
    },
    web: { bundler: 'metro', favicon: './assets/favicon.png', name: 'INVIZENT' },
    plugins: [
      ['@config-plugins/react-native-webrtc', { cameraPermission: 'Камера нужна для видеосообщений и видеозвонков. Видео шифруется до отправки.', microphonePermission: 'Микрофон нужен для голосовых сообщений и звонков. Звук шифруется.' }],
      './plugins/withLineSignal',
      './plugins/withLinePhoto',
      './plugins/withLineNearby',
      './plugins/withLineVideo',
      './plugins/withScreenBroadcast',
      // Montserrat (SIL OFL 1.1), embedded natively; family 'Montserrat' with weights 400–800.
      ['expo-font', {
        ios: { fonts: ['./assets/fonts/Montserrat-Regular.ttf','./assets/fonts/Montserrat-Medium.ttf','./assets/fonts/Montserrat-SemiBold.ttf','./assets/fonts/Montserrat-Bold.ttf','./assets/fonts/Montserrat-ExtraBold.ttf'] },
        android: { fonts: [{ fontFamily: 'Montserrat', fontDefinitions: [{path:'./assets/fonts/Montserrat-Regular.ttf',weight:400},{path:'./assets/fonts/Montserrat-Medium.ttf',weight:500},{path:'./assets/fonts/Montserrat-SemiBold.ttf',weight:600},{path:'./assets/fonts/Montserrat-Bold.ttf',weight:700},{path:'./assets/fonts/Montserrat-ExtraBold.ttf',weight:800}] }] },
      }],
      'expo-asset',
      // «Картинка в картинке»: a video opened from a chat keeps playing in the system's small window when the app is
      // left (iOS: needs the 'audio' background mode, already declared above; Android: the activity flag).
      ['expo-video', { supportsPictureInPicture: true }],
      ['expo-audio', {
        microphonePermission: 'Инвиз использует микрофон только во время записи голосового сообщения. Запись шифруется до отправки.',
        recordAudioAndroid: true,
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
      }],
      // Sideloaded builds have no Push entitlement; the App Store build (IOS_PUSH=1) keeps it (APNs on the server).
      // Listed BEFORE expo-notifications on purpose: a mod added later runs earlier, so this plugin only
      // sees (and removes) the entitlement when expo-notifications' mod has already run.
      ...(process.env.IOS_PUSH === '1' ? [] : ['./plugins/withNoIosPush']),
      // iOS: «aps-environment» entitlement (APNs); Xcode sets production for App Store exports anyway.
      ['expo-notifications', { icon: './assets/notification-icon.png', color: '#4C7DFF', defaultChannel: 'messages', mode: development ? 'development' : 'production' }],
      './plugins/withSelfUpdate',
      // Only DeviceMotion (wallpaper parallax); the pedometer's ACTIVITY_RECOGNITION is in blockedPermissions.
      ['expo-sensors', { motionPermission: 'Инвиз использует наклон телефона только для лёгкого движения обоев в чатах.' }],
      // Face ID / Touch ID for the passcode lock (src/lock); the code itself never leaves the device.
      ['expo-local-authentication', { faceIDPermission: 'Face ID открывает Инвиз без ввода код-пароля.' }],
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
        // Kept although it now equals the default: removing a chosen Android alias on update can hide the app from the launcher.
        { name: 'Outline', ios: './assets/icons/outline.png', android: { foregroundImage: './assets/icons/outline-android.png', backgroundColor: '#0C0C0E' } },
        { name: 'Blue', ios: './assets/icons/default.png', android: { foregroundImage: './assets/icons/default-android.png', backgroundColor: '#07070A' } },
        { name: 'Aurora', ios: './assets/icons/aurora.png', android: { foregroundImage: './assets/icons/aurora-android.png', backgroundColor: '#162563' } },
      ]],
      './.linea-ios-cloud-setup/withLocalPrivacy.cjs',
    ],
  },
};
