# Сборка и установка Линии 0.5.1

## Передача и границы

Обновление 0.5.1 содержит исходники Android/iPhone и сервера, подготовку облачной iOS-сборки и новые проверки: [PREPARATION_REPORT_0.5.1.md](PREPARATION_REPORT_0.5.1.md). Нового APK или IPA здесь нет. Фактические размер, SHA-256, сертификат, manifest и выравнивание библиотек ранее собранного APK 0.5.0 записаны в [BUILD_REPORT_0.5.md](BUILD_REPORT_0.5.md) и [APK_VERIFICATION_0.5.json](APK_VERIFICATION_0.5.json). [TEST_REPORT.md](TEST_REPORT.md) относится к этой прежней версии.

APK собран в release-режиме для arm64-v8a, package `com.linea.messenger.preview`, versionName `0.5.0`, versionCode `5`. Подпись Android Debug предназначена только для preview; публичный выпуск требует ключа владельца. Установка на физический Android, Xcode, подписанный IPA и работа iPhone здесь не проверены.

**Expo Go не подходит:** требуются LineaSignal, LineaPhoto, LineaVideo и SQLCipher. Standalone APK уже содержит JavaScript и ресурсы; Metro для его использования не нужен.

## Подключение готового APK

Для личных чатов нужен собственный работающий сервер с HTTPS и действующим сертификатом. Инструкция для двух своих доменов .ru/.com: [DEPLOYMENT.md](DEPLOYMENT.md). Введите HTTPS-адрес на экране подключения. Готовая release/preview-сборка отвергает HTTP даже для LAN/localhost; это защищает вход и серверную сессию дополнительно к E2EE содержимого.

Два аккаунта должны использовать один сервер. Перед первым обменом оба участника сравнивают коды устройств в «Защите чата» через доверенный канал. Неизвестный ключ блокирует отправку. Восстановление пароля не переносит ключи старой истории на новый телефон. Звонки ещё не реализованы; их будущая приёмка требует только E2EE — [E2EE_ONLY_0.5.md](E2EE_ONLY_0.5.md).

Музыка открывается с экрана подключения/входа без регистрации в Линии; Audius требует интернет. Свои импортированные аудиофайлы доступны локально. Яндекс Музыка и SoundCloud не подключены.

## Подготовка

Нужны Node.js 24 LTS, JDK 21 и Android SDK. Из корня:

```bash
npm run setup
```

Setup устанавливает зависимости по lockfiles и при отсутствии создаёт `mobile/.env.local` с пустым API URL и выключенным local HTTP. Задайте свой HTTPS URL или выберите адрес в приложении. Не включайте секреты в `EXPO_PUBLIC_*`; эти значения попадают в клиент.

Текущая среда: Expo SDK 57, React Native 0.86.3, Android SDK platform/Build Tools 36, NDK 27.1.12297006, CMake 3.22.1. Плагин Signal закрепляет Kotlin 2.2.20, Java/Kotlin target 17, desugaring и official Signal Maven repository. Для Gradle используется JDK 21. Укажите реальные пути через JAVA_HOME и ANDROID_HOME; временные пути нашей среды копировать не нужно.

## Android из исходников

Из `mobile`:

```bash
npm ci
npm run typecheck
npx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=2
```

На Windows используйте gradlew.bat. Результат — `mobile/android/app/build/outputs/apk/release/`. Generated Android/iOS application directories, зависимости, кэши, базы и ключи исключены из архива. Исходники Android/iOS всех трёх собственных модулей в `mobile/modules` включены.

Сетевые ошибки сертификатов следует исправлять правильным доверенным CA/truststore среды, без отключения TLS. В нашей среде потребовалось явно выбрать системное хранилище Java CA для новых Maven-зависимостей. Это настройка build-среды; в распространяемый APK она не включается.

### Локальная разработка

HTTP для одноразовых тестовых аккаунтов разрешается только при **одновременном** выполнении двух условий: dev runtime `__DEV__` и явная переменная `EXPO_PUBLIC_ALLOW_LOCAL_HTTP=1`. Допускаются только локальные адреса. Изменение native network config требует нового prebuild/dev build:

```bash
cd mobile
export EXPO_PUBLIC_ALLOW_LOCAL_HTTP=1
export EXPO_PUBLIC_API_URL=http://192.168.1.10:3001
npx expo prebuild --platform android --no-install
npx expo run:android
```

Замените LAN-IP своим. localhost на телефоне означает сам телефон. Для распространения верните `EXPO_PUBLIC_ALLOW_LOCAL_HTTP=0`, выполните новый prebuild и release build. Release runtime не разрешает HTTP даже при ошибочно включённом dev-флаге.

## iPhone без собственного Mac или ПК

Управлять сервером и запускать сборку можно с iPhone: VPS исполняет CLI, EAS собирает приложение на удалённой macOS-машине, результат устанавливается на разрешённый профилем подписи iPhone. Полный маршрут, регистрация устройства, реальные идентификаторы и команды находятся в [tools/ios-cloud-setup/README.md](../tools/ios-cloud-setup/README.md). Наличие включённого Developer Mode не заменяет сертификат, профиль и выполненную сборку.

Исходники 0.5.1 уже содержат `ios.useFrameworks: static`, необходимый для выбранной интеграции libsignal, и завершающую проверку ограничений геолокации/межприложного доступа. Выполнены Expo config и iOS prebuild без установки Pods. Это проверка подготовки проекта, не Swift/Xcode-компиляция, не подпись и не испытание на устройстве.

## iPhone: локальная сборка на Mac

Нужны Mac, совместимые Xcode/CocoaPods, свой bundle identifier, team и signing:

```bash
cd mobile
npm ci
npx expo prebuild --platform ios
npx expo run:ios
```

Плагин подключает LibSignalClient official tag v0.106.0 с проверкой FFI archive SHA-256; expo-sqlite включает SQLCipher. Для удаления фона Vision нужен iOS 17+. Video module использует AVFoundation/Photos. Это исходный код, а не подтверждение успешной Swift-компиляции или готовый IPA. EAS build и публикация в магазинах не выполнялись.

## Проверки

```bash
npm run check
```

Команда выполняет серверные и мобильные регрессии для музыки, ручного ввода, дат, фото/медиа, AI, тем/статусов, HTTPS и TypeScript. Настоящий Node Signal используется только в test tooling, не добавляется в production server/mobile зависимости. Подготовка — [E2EE_TEST_REPORT.md](E2EE_TEST_REPORT.md).

Для native interop из `mobile/android`:

```bash
./gradlew -p ../modules/linea-signal/jvm-tests test interopClasspath
```

Затем из корня `npm run test:e2ee`. Нужен JDK 21; при необходимости `LINEA_SIGNAL_TEST_JAVA` задаёт путь к java. Полный мобильный прогон базовой версии 0.5.0 включал все `mobile/test/*.test.mjs`, включая E2EE; объём повторных проверок 0.5.1 указан в отдельном отчёте. Генерируемый classpath и test tooling в архив не входят.

## Темы и визуальная проверка

По умолчанию приложение следует ОС. Ручные варианты: светлая, navy, black. Black имеет базу #000000 и полупрозрачные чёрные панели; выбор сохраняется. GlassEffect/blur используются по доступности платформы, предусмотрены запасные материалы. [Glass-HQ/liquid-glass](https://github.com/Glass-HQ/liquid-glass) — визуальный ориентир.

Web export проверяет JavaScript/UI-сборку, но не нативный media path. В web нет E2EE-переписки и нативного редактора; открытая отправка не подставляется вместо них. Попытка получить актуальные скриншоты через браузер была отклонена политикой доступа к локальному URL; обход не выполнялся. Скриншотов этой версии нет, визуальный gate не пройден. Подробнее: [PROFILE_THEME_UI_REPORT.md](PROFILE_THEME_UI_REPORT.md).

## Публичный выпуск

```bash
export APP_ENV=production
export EXPO_PUBLIC_API_URL=https://api.example.com
export EXPO_PUBLIC_ALLOW_LOCAL_HTTP=0
```

Замените example своим HTTPS-сервером. Используйте свои identifiers и signing key. До публичного выпуска нужны физические Android/iPhone, внешний HTTPS/WSS, восстановление копии и независимая проверка безопасности. Реальный сервер/домены, покупки Platina, звонки и весь функционал Telegram в эту передачу не входят.
