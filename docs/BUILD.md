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

### APK из CI (GitHub Actions)

Workflow `.github/workflows/android-apk.yml` собирает тот же `assembleRelease` на `ubuntu-latest` (JDK 21, platform/Build Tools 36, NDK 27.1.12297006, Node 24) при каждом push в `main`, затрагивающем `mobile/` (кроме `mobile/test/**` и web-адаптеров `*.web.ts(x)`), и вручную (Actions → «Android APK» → Run workflow). По умолчанию — preview-package `com.linea.messenger.preview`, только `arm64-v8a`, push включён; ручной запуск позволяет выбрать `production` (`com.linea.messenger`, обязателен HTTPS `api_url`), `universal` (все четыре ABI) и `push=false` (`ANDROID_PUSH=0`, APK без уведомлений — факт отмечается в summary). Второй job того же workflow прогоняет Kotlin JVM-тесты `mobile/modules/*/jvm-tests`.

Версии Gradle. Сам APK собирается wrapper'ом сгенерированного `expo prebuild` проекта `mobile/android` — Gradle 9.3.1, тот же, что и локально. Job Kotlin JVM-тестов использует `gradle/actions/setup-gradle` с Gradle 8.14.3 (версия, с которой эти проекты прогонялись в последний раз; у них нет своего wrapper'а). Локально `./gradlew -p ../modules/<module>/jvm-tests test` из `mobile/android` запускает те же тесты на 9.3.1 — расхождение версий намеренное и на результат не влияет.

Скачать: страница запуска → Artifacts → `invizent-android-arm64` (или `-universal`; суффикс `-debugsigned` см. ниже). Внутри `INVIZENT-<versionName>-Android-<arm64|universal>[-debugsigned].apk`, `SHA256SUMS`, `BUILD.json` (версия, versionCode, package, режим подписи, отпечаток сертификата, commit) и `signer.txt`. Те же SHA-256, versionName/versionCode и режим подписи печатаются в job summary. После подписи job проверяет `zipalign -c 4` и 16 KB page alignment нативных библиотек (`zipalign -c -P 16 4`; если Build Tools не знают `-P`, выдаётся предупреждение, сборка не падает).

Публикация preview (`publish-preview.yml`) не скачивает APK из Actions: она делает `checkout` коммита из input `apk_commit` и ожидает в его корне проверенные `INVIZENT-<version>-Android-arm64.apk`, `SHA256SUMS` и `BUILD.json` (сверяет `sha256sum -c` и `.version` с `mobile/package.json`). Поэтому после удачного запуска содержимое артефакта (`out/*`, кроме APK с суффиксом `-debugsigned`) коммитят в отдельную ветку `apk`:

```bash
git switch --orphan apk        # или git switch apk, если ветка уже есть
unzip -o invizent-android-arm64.zip      # скачанный артефакт
sha256sum -c SHA256SUMS
git add INVIZENT-*.apk SHA256SUMS BUILD.json signer.txt
git commit -m "APK $(jq -r .version BUILD.json) from $(jq -r .commit BUILD.json)"
git push origin apk
```

SHA этого коммита и передаётся в `apk_commit` при запуске «Publish … preview downloads». В ветке `apk` нет исходников, поэтому её не нужно держать в синхроне с `main`.

Подпись. Gradle подписывает APK шаблонным debug-ключом Expo, после чего job переподписывает его `apksigner` (v2+v3):

- Есть все четыре секрета `ANDROID_KEYSTORE_B64` (keystore в base64: `base64 -w0 release.keystore`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — APK подписан ключом владельца, обновление ставится поверх предыдущих сборок с тем же ключом. Ключ создаётся один раз: `keytool -genkeypair -v -keystore release.keystore -alias invizent -keyalg RSA -keysize 4096 -validity 10000`; keystore хранится только у владельца и в секретах, в репозиторий не попадает (`*.keystore` в `.gitignore`).
- Секретов нет — job генерирует одноразовый debug-keystore, артефакт получает суффикс `-debugsigned`. Такой APK только для проверки: у каждого запуска новый ключ, перед установкой следующего CI-APK предыдущий нужно удалить. Для публикации он не годится.
- Заданы не все секреты — job останавливается сразу, чтобы случайно не выпустить debug-подписанный APK.

Push и `google-services.json`: при наличии секрета `GOOGLE_SERVICES_JSON_B64` (файл в base64) он записывается во временный файл и передаётся через `GOOGLE_SERVICES_FILE`; иначе берётся закоммиченный `mobile/google-services.json`, в котором есть только preview-package. Для `production` без секрета job падает ещё до Gradle с указанием, что package не зарегистрирован (см. «Push-уведомления»); сборка без push требует явного `push=false`. Дополнительно, как и в остальных workflow, используется `ATTEST_KEY` (пустой = подпись запросов выключена).

Гейт качества — `.github/workflows/quality.yml`: на каждый pull request и push в `main` отдельными job выполняются серверные тесты (`node --test test/*.test.js`), мобильные `tsc --noEmit` + `node --test test/*.test.mjs` и desktop `npm test`; завершающий job `gate` красный при любой неудаче — его и стоит сделать required check в branch protection.

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

## Push-уведомления

Сервер отправляет только имя отправителя и «Новое сообщение» / «Входящий звонок»: текст сообщений зашифрован end-to-end и в push не попадает. Пока приложение открыто, всё приходит по WebSocket. Чтобы уведомления приходили при закрытом приложении, владелец настраивает две вещи: ключи на сервере и файлы конфигурации в сборке.

### Android (Firebase Cloud Messaging)

1. В консоли Firebase (проект `invizent`) → Project settings → Your apps → Add app → Android: зарегистрируйте **оба** package — `com.linea.messenger.preview` (уже есть) и `com.linea.messenger` (release). Скачайте обновлённый `google-services.json`: один файл содержит оба клиента, Gradle-плагин сам выбирает запись по `package_name`.
2. Положите файл в `mobile/google-services.json` (или укажите путь в `GOOGLE_SERVICES_FILE`, например из секрета CI). Файл не содержит секретов, но его всё равно не стоит публиковать шире репозитория.
3. На сервере: Project settings → Service accounts → Generate new private key, затем `bash deploy/push.sh /путь/к/ключу.json`. Ключ остаётся в `deploy/secrets/fcm.json`, переменная `FCM_SERVICE_ACCOUNT` выставляется автоматически.

Как сборка использует файл: `app.config.js` подключает `googleServicesFile` **во всех** сборках (раньше — только в preview, и релизный APK молча оставался без push). Если файл не содержит package текущей сборки, `expo prebuild` печатает предупреждение `[push] …`, а `./gradlew assembleRelease` останавливается с ошибкой «No matching client found for package name» — это намеренно. Сборка без уведомлений делается осознанно: `ANDROID_PUSH=0 npx expo prebuild --platform android`.

### iPhone (APNs, напрямую через Apple)

1. developer.apple.com → Certificates, Identifiers & Profiles → Keys → «+» → включите Apple Push Notifications service (APNs), скачайте `AuthKey_XXXXXXXXXX.p8` (скачивается один раз). Там же проверьте, что у App ID (`com.invizent.app` или ваш `IOS_BUNDLE_ID`) включена capability Push Notifications.
2. На сервере: `bash deploy/apns.sh /путь/к/AuthKey_XXXXXXXXXX.p8` — скрипт спросит Team ID (Membership) и Bundle ID; **Bundle ID должен совпадать с тем, что подписан в сборке** (для App Store — значение `bundle_id` из workflow `ios-appstore.yml`, по умолчанию `com.invizent.app`). Ключ сохраняется в `deploy/secrets/apns.json`, переменная `APNS_CREDENTIALS` выставляется автоматически. Выключить: `bash deploy/apns.sh off`.
3. Сборка: workflow `ios-appstore.yml` задаёт `IOS_PUSH=1`, поэтому entitlement `aps-environment` остаётся в приложении (`mode: production` при `APP_ENV=production`; Xcode при экспорте в App Store всё равно ставит production). Сборки без `IOS_PUSH` (sideload, симулятор, `ios-unsigned-ipa.yml`) убирают entitlement плагином `plugins/withNoIosPush.js` — там push недоступен, и приложение показывает это в статусе, а не падает. Токен, который production-шлюз Apple отвергает, сервер автоматически пробует через sandbox (сборки с development-профилем, TestFlight через production).

В приложении (`mobile/src/push.ts`) iPhone регистрирует hex-токен APNs через `PUT /me/push` с `platform: "ios"`, Android — токен FCM с `platform: "android"`. Ответ `enabled:false` означает, что на сервере нет ключа для этой платформы; статус (`usePushStatus()` / `pushStatusText()`) доступен для экрана настроек. Проверка сервера: `cd server && node --test test/push*.test.js`.

Режим `voip` в `UIBackgroundModes` не объявлен: он требует PushKit + CallKit, которых в приложении пока нет; входящий звонок при закрытом приложении приходит обычным уведомлением с `interruption-level: time-sensitive`.

## Публичный выпуск

```bash
export APP_ENV=production
export EXPO_PUBLIC_API_URL=https://api.example.com
export EXPO_PUBLIC_ALLOW_LOCAL_HTTP=0
```

Замените example своим HTTPS-сервером. Используйте свои identifiers и signing key. До публичного выпуска нужны физические Android/iPhone, внешний HTTPS/WSS, восстановление копии и независимая проверка безопасности. Реальный сервер/домены, покупки Platina, звонки и весь функционал Telegram в эту передачу не входят.
