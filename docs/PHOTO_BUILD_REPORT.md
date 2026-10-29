# Android APK Linea 0.4.0 — фактическая сборка и проверка

Дата: **28 октября 2026 года**. Этот отчёт относится к APK **0.4.0**, включающему редактор фото и обязательную подготовку PNG перед отправкой. Исторические отчёты `NATIVE_TEST_REPORT.md`, `NATIVE_SOURCE_MANIFEST.json` и `NATIVE_ARTIFACT_VERIFICATION.json` описывают версию 0.3.0 и не перезаписывались.

## Готовый файл

**`linea-0.4.0-preview-arm64.apk`**

| Параметр | Проверенное значение |
|---|---|
| Размер | **61 822 951 байт**, 58,96 МиБ |
| Package | `com.linea.messenger.preview` |
| Version name / code | `0.4.0` / `4` |
| Архитектура | Только `arm64-v8a` |
| Минимальная Android | API 26 — Android 8.0 |
| Target SDK | 36 |
| Debuggable | false; атрибут не объявлен, используется значение Android по умолчанию |
| Allow backup | false |
| APK signature | Scheme v2 — проверка `apksigner` пройдена |
| APK alignment | `zipalign -c -P 16 -v 4` — пройдена |
| Native ELF | Все **19** библиотек имеют LOAD alignment не меньше 16 КиБ |
| Нативные модули | `LinePhotoModule` и `LineSignalModule` присутствуют в DEX и зарегистрированы Expo |
| SQLCipher | Присутствует в `lib/arm64-v8a/libexpo-sqlite.so`; build-настройка включена |

SHA-256 APK:

```text
1a4d804b95243160f0c6df15b17665a2153cff071c9205fd1d4871176ff4f9ee
```

SHA-256 сертификата:

```text
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

Сертификат совпадает с предыдущими preview-версиями. Перед prebuild существующий keystore был сохранён во временной закрытой папке и после prebuild побайтово сверён. Это **тестовая подпись Android Debug**, а не ключ владельца для публичного выпуска. Закрытый ключ в архив исходников не включается.

## Как получен APK

Перед сборкой зафиксированы **78 производственных файлов** клиента: входной файл, React Native исходники, конфигурация, плагины, assets, package/lockfiles и Android/iOS исходники локальных модулей. Затем выполнен `expo prebuild --platform android --no-install`. Generated Android-каталог был пересоздан; production inputs и preview keystore сохранились.

Полная `:app:assembleRelease` завершилась **BUILD SUCCESSFUL за 4 минуты 34 секунды**: 433 задачи, 405 выполнены, 28 актуальны. Использованы JDK Temurin 21, Gradle 9.3.1, Android SDK/Build Tools 36.0.0, Kotlin 2.2.20 и основной NDK 27.1.12297006. Java/Kotlin target 17 сохранён для согласования с React Native. SQLCipher использует свой закреплённый NDK 27.0.12077973.

Команда из generated `mobile/android`, при настроенных JDK и SDK:

```sh
./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --max-workers=2 \
  '-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m'
```

Metro собрал production entry **`index.ts`, 806 модулей, 13 251 мс**. JS/Hermes bundle встроен в APK как `assets/index.android.bundle`; отдельный Metro-сервер для запуска готового APK не нужен. Проверено наличие Signal JNI, SQLCipher и обоих собственных нативных модулей. Наши `SignalInteropKt`, `PhotoPixelsTest` и `PhotoOptionsTest` в DEX не обнаружены. Упакованная upstream-библиотека `libsignal_jni_testing.so` является частью поставки SDK; утверждение об отсутствии любых тестовых символов всех зависимостей не делается.

SHA-256 встроенного bundle:

```text
a8852a8d03cba2677b0665b1ac47cefa54ac52a7531f91002df0430d251a7daf
```

После сборки повторно проверены все 78 файлов: **изменений нет**. Общий хеш исходного манифеста:

```text
8f3cb928e5bb7aa564aa5ed5a0065dbb73a4e6ebf72ab5693ac355109a3e23f3
```

Способ вычисления и отдельные SHA-256 записаны в [PHOTO_BUILD_SOURCE_MANIFEST.json](PHOTO_BUILD_SOURCE_MANIFEST.json). Проверялись также CRC ZIP-записей APK, реальный AndroidManifest, подпись готового файла и программные заголовки всех ELF-библиотек.

## Проверки и границы результата

Этот APK содержит реализацию из [PHOTO_NATIVE_REPORT.md](PHOTO_NATIVE_REPORT.md). До полной сборки прошли **10 JVM-тестов** настоящих Kotlin pixel algorithms и проверок параметров. Включённые функции фото — локальная обработка; бикубическое увеличение и диффузионное заполнение не обозначаются как нейросетевые модели.

**Установка APK, выполнение ML Kit на Google Play services и обмен сообщениями на физических телефонах в этой среде не проверялись.** Нативная компиляция, наличие классов и корректная подпись не подтверждают качество масок реальных фотографий, поведение клавиатуры/галереи, потребление памяти или совместимость с каждым устройством. iOS/Xcode сборка, подпись и IPA также не выполнялись.

Загрузка ML Kit-модели на телефон не является частью компиляции APK. При отсутствии Google Play services/модели интерфейс должен сообщать недоступность, сохраняя остальные режимы обработки. Условия сетевых обращений SDK описаны в отчёте нативного модуля.

APK собран в preview-конфигурации. `usesCleartextTraffic=true` нужен для локального тестового API; адреса приложения проходят собственную проверку, а внешний сервер требует HTTPS. Рабочий сервер к APK не прилагается. Для переписки нужен развёрнутый API и зарегистрированные пользователи; встроенной демонстрационной авторизации нет.

## Доказательства

- [PHOTO_APK_VERIFICATION.json](PHOTO_APK_VERIFICATION.json) — машиночитаемые метаданные APK, manifest, модули и ELF alignment.
- [PHOTO_BUILD_SOURCE_MANIFEST.json](PHOTO_BUILD_SOURCE_MANIFEST.json) — снимок production inputs и проверка неизменности.
- [android-prebuild.txt](photo-evidence/android-prebuild.txt) — prebuild.
- [android-v04-release-build.txt](photo-evidence/android-v04-release-build.txt) — полная release-сборка.
- [v04-apk-signature.txt](photo-evidence/v04-apk-signature.txt) — подпись и сертификат.
- [v04-apk-zipalign.txt](photo-evidence/v04-apk-zipalign.txt) — выравнивание APK.
- [v04-apk-manifest.xml](photo-evidence/v04-apk-manifest.xml) — AndroidManifest из готового APK.
- [v04-elf-alignment.txt](photo-evidence/v04-elf-alignment.txt) — программные заголовки нативных библиотек.

## Журнал сборки

1. Получен общий JS/native freeze; сохранены SHA-256 78 входных файлов.
2. Сохранён прежний preview keystore, выполнен prebuild; ключ и исходники сверены.
3. Собран только arm64 release APK, без отключения компиляторских, lint-vital или подписных проверок.
4. Проверен именно итоговый APK: подпись, version/package/SDK, backup/debug flags, DEX, native libraries, bundle, ZIP CRC, ZIP/ELF alignment.
5. Исходники повторно сверены с исходным снимком. APK скопирован в отдельный файл для передачи.
6. Созданы отдельные отчёты 0.4.0; исторические результаты 0.3.0 оставлены неизменными.
