# Сборка iOS IPA — Линия 0.5.1

Дата: 2026-10-28. Среда: GitHub Actions, раннер `macos-26-intel`, Xcode 26.6 (17F113), iOS SDK 26.5.
Workflow: `.github/workflows/ios-unsigned-ipa.yml`, успешный запуск 40704162002, коммит 26e9b71.

## Результат
- `Linea-iOS-arm64-unsigned.ipa`, 21 691 651 байт, SHA-256 `14b7c09d3598cbefad6feebe85fd69b434795d3aecf275522d350b5f3c8bd623`.
- ZIP-контейнер с `Payload/Linea.app`, целостность проверена (`unzip -t`).
- Исполняемый файл `Liniya`: Mach-O 64-bit arm64, LC_BUILD_VERSION platform 2 (iOS device), minos 16.4, sdk 26.5.
- `DTPlatformName = iphoneos`; bundle ID `com.linea.messenger.preview`; версия 0.5.1 (1); MinimumOSVersion 16.4 = IPHONEOS_DEPLOYMENT_TARGET 16.4.
- `main.jsbundle` встроен: Hermes bytecode v98, 2 845 100 байт — Metro не нужен.
- 17 встроенных фреймворков в `Frameworks/`, все Mach-O arm64.
- libsignal 0.106.0 слинкован статически (655 экспортированных символов `signal_*`); SQLCipher присутствует.
- Подписи нет (ожидаемо): подписать в GBox.

## Приватность и сеть
- ATS: `NSAllowsArbitraryLoads = false` (произвольный HTTP запрещён), `NSAllowsLocalNetworking = true` (шаблон Expo; локальная сеть).
- Нет ключей `NSLocation*`, нет `LSApplicationQueriesSchemes`; фоновый режим только `audio`. Entitlements пустые.
- TLS, аутентификация и E2EE не изменялись.

## Исправленные проблемы
1. `modules/linea-video/ios/VideoProcessor.swift`: вызов, который может бросить ошибку, внутри `&&` без `try` → проверка размера вынесена в отдельный `if` с `try`. Логика лимита та же.
2. `modules/linea-video/ios/VideoSamples.swift`: несуществующая константа `kCMSampleAttachmentKey_IsDependedOnBy` → `kCMSampleAttachmentKey_IsDependedOnByOthers` (правильное имя CoreMedia).
3. `modules/linea-signal/ios/LineaSignal.podspec`: при `useFrameworks: static` приложение не находило официальный `libsignal_ffi.a` (Undefined symbols `_signal_*`). Добавлен путь поиска библиотеки для app target; версия 0.106.0 и проверка SHA-256 архива не менялись.
4. Добавлен workflow сборки неподписанного IPA для iphoneos с проверками.

## Проверки до сборки (Linux)
- `tsc --noEmit` — без ошибок; `expo export --platform ios` — успешно.
- JS-тесты (Node 24): 301 из 302 пройдено. Не запускался 1 тест Kotlin/JVM-интеропа (Android, требует Gradle).

## Не проверено
- Запуск на iOS Simulator и на физическом iPhone не выполнялся.
- Вход, вкладки, отправка сообщений и E2EE на устройстве не проверены — нужен ваш HTTPS-сервер.
- Работа после подписи GBox не проверена.
