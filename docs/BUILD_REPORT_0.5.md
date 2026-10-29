# Линия 0.5.0 — проверенная Android-сборка с SVG PLATINA

Дата: **28 октября 2026 года**. Итоговый **linea-0.5.0-preview-arm64.apk** собран и проверен: **63,872,204 байта (60.91 МиБ)**. Это release APK с сохранённым тестовым сертификатом Android Debug для предварительного тестирования. Физическая установка и работа на телефоне не проверены.

Окончательная попытка Gradle завершилась с **exit 0, BUILD SUCCESSFUL in 1m 40s**: **470 задач, 34 выполнены, 436 up-to-date**. Затем отдельный проверяющий скрипт завершился с **exit 0**. Прежний повреждённый файл заменён только после прохождения проверки; SHA-256 конечной копии повторно совпал с проверенным APK. [Полный журнал сборки](evidence-v05-build/android-v05-release-build.txt), [результат проверки](evidence-v05-build/apk-isolated-verification-result.txt).

## Проверки готового файла

| Проверка | Фактический результат |
| --- | --- |
| Package | `com.linea.messenger.preview` |
| Версия | `0.5.0`, versionCode `5` |
| Android | minSdk 26 — Android 8.0+, targetSdk 36 |
| Архитектура | Только `arm64-v8a` |
| Подпись | APK Signature Scheme v2 проверена; сертификат совпадает с прежним preview |
| Manifest и ресурсы | `AndroidManifest.xml` и `resources.arsc` присутствуют; 1300 записей `res/` |
| ZIP | 1555 записей; CRC проверены, дубли имён отсутствуют |
| Выравнивание APK | `zipalign -c -P 16 -v 4` пройден |
| ELF | 21 нативная библиотека; LOAD alignment каждой не менее 16 КиБ |
| Временные native-файлы | Скрытые файлы внутри `lib/` отсутствуют |
| Защита транспорта | `usesCleartextTraffic=false`; release runtime принимает только HTTPS |
| Backup/debug | `allowBackup=false`, `debuggable=false` |
| Определения классов | В DEX подтверждены именно `class_def` для MainActivity, MainApplication, ExpoModulesPackageList и LinePhotoModule/LineSignalModule/LineVideoModule |
| Регистрация модулей | Все три собственных нативных модуля присутствуют в сгенерированном списке Expo |
| Хранилище | В `libexpo-sqlite.so` обнаружён SQLCipher; generated Gradle property `expo.sqlite.useSQLCipher=true` |
| Собственные тесты и CLI | Определения проверяемых JVM-тестов и SignalInterop CLI отсутствуют в DEX |
| JavaScript | Hermes bundle присутствует, 880 модулей; хеш записан в машиночитаемом результате |
| SVG PLATINA | Оба варианта найдены внутри APK и побайтово совпадают с замороженными исходниками |
| Исходники | Все 165 входных файлов совпали со снимком и в основном проекте, и в изолированном каталоге сборки |

В manifest нет разрешений камеры, микрофона, геолокации медиа, WRITE_EXTERNAL_STORAGE и READ_MEDIA_AUDIO. Полный список разрешений находится в JSON результата; эта выборочная проверка не является аудитом разрешений всего приложения.

Оптимизатор ресурсов переименовал SVG: `platina-chrome.svg` находится в `res/DE.svg`, а `platina-chrome-light.svg` — в `res/97.svg`. Проверялись сами байты, а не исходное имя ZIP-записи. Это подтверждает включение правильных ресурсов, но не их отображение на физическом экране.

SHA-256 окончательного APK:

```text
703f42adc995dcc713bb25fd199ad4e5eb7c9b7e6a95dc8512622b18415a88b2
```

SHA-256 сертификата preview:

```text
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

Машиночитаемые результаты — [APK_VERIFICATION_0.5.json](APK_VERIFICATION_0.5.json). Снимок — [BUILD_SOURCE_MANIFEST_0.5.json](BUILD_SOURCE_MANIFEST_0.5.json), aggregate SHA-256 `be45eda17afd7afed27c30bc4f6fa971b348af3ac08137ee8c081fa8da3e8b51`. Проверяющий скрипт — [verify-isolated-apk.py](evidence-v05-build/verify-isolated-apk.py). Проверки подписи, manifest, ZIP alignment и ELF записаны отдельно: [подпись](evidence-v05-build/v05-apk-signature.txt), [manifest](evidence-v05-build/v05-apk-manifest.xml), [zipalign](evidence-v05-build/v05-apk-zipalign.txt), [ELF](evidence-v05-build/v05-elf-alignment.txt).

## Как получена окончательная сборка

Исходники перенесены в `/tmp/linea-v05-isolated`: все 165 файлов сначала сверены с замороженным снимком. Установленные npm-зависимости скопированы отдельно; старые generated Android, нативные build-каталоги, `.gradle`, `.cxx` и реальные env-файлы не переносились. Скомпилированные JavaScript-каталоги зависимостей сохранены. Expo prebuild создал согласованные `MainActivity`/`MainApplication` с package `com.linea.messenger.preview`. После prebuild все 165 входов снова совпали. [Снимок переноса](evidence-v05-build/isolated-stage-inputs-before.json), [prebuild](evidence-v05-build/android-isolated-prebuild.txt).

Сертификат preview восстановлен отдельно. Использованы JDK 21, Android SDK 36, NDK 27.1.12297006 и Gradle 9.3.1; сборка ограничена arm64. Отключены наблюдение за файловой системой, task build cache, configuration cache и параллельное выполнение; один worker, Kotlin compiler in-process. Существующий внешний кэш зависимостей Gradle использован. HTTPS проверяется с системным Java CA-хранилищем `/etc/ssl/certs/java/cacerts`; TLS не отключался. `EXPO_PUBLIC_ALLOW_LOCAL_HTTP=0`, реальный env не загружался. Точная команда с несекретными параметрами — [android-isolated-invocation.json](evidence-v05-build/android-isolated-invocation.json).

Первый полный проход в этом каталоге выполнил **444 задачи за 11m 11s**, но завершился с **exit 1**: обязательный Android Lint исчерпал **JVM Metaspace 384 МиБ** при анализе async-storage. Компиляция нативных модулей, приложения, DEX и Metro до этого завершилась. На повторе изменён только лимит Metaspace до **768 МиБ**; heap остался **1536 МиБ**. Lint не отключался. Повтор использовал готовые результаты задач и завершил обязательные проверки и упаковку. [Первый полный журнал с ошибкой](evidence-v05-build/android-isolated-first-metaspace-failed.txt), [первая команда](evidence-v05-build/android-isolated-first-invocation.json).

Это ошибка лимита памяти JVM, а не установленный факт убийства процесса ядром. Счётчики kernel OOM до и после остались `oom=2`, `oom_kill=1`; их предыдущая история не приписывается этому запуску. [До сборки](evidence-v05-build/android-isolated-memory-before.json), [после](evidence-v05-build/android-isolated-memory-after.json).

Metro создал bundle из **880 модулей** в первом проходе; после изменения только параметра памяти эта задача была `UP-TO-DATE`. Успех отдельного этапа Metro не объявляется успешным завершением первого прохода. Итоговая проверка извлекла и захешировала bundle из окончательного APK.

## Предыдущие неудачные артефакты

В основном рабочем каталоге до изолированного запуска наблюдались ошибки временных native-файлов, конфликт двух поколений DEX-класса `androidx.autofill.R$attr` и несогласованные generated Kotlin package/namespace. Один проход даже сообщил `BUILD SUCCESSFUL`, но его APK не содержал manifest и ресурсов и был отклонён проверкой. Эти файлы не являются итогом выпуска. Повреждение промежуточного `linked`-архива отдельно не следует автоматически переносить на конечный optimized resource input: на следующем проходе оптимизированный архив уже был валиден.

Причина всех файловых несогласованностей не установлена; предположение о синхронизации рабочего каталога не выдаётся за доказанный диагноз. Изолированный prebuild и сборка завершились без изменений production-исходников или плагинов. Последний workspace-сбой сохранён в [android-workspace-fresh-package-failed.txt](evidence-v05-build/android-workspace-fresh-package-failed.txt); успешным результатом служат только итоговые isolated log и APK verification выше.

## TypeScript, экспорт и границы проверки

После подключения окончательных SVG выполнен экспорт всех платформ: **web 556, Android 880, iOS 867 модулей; 42 ресурса**, оба SVG включены. [Финальный export-all.txt](evidence-v05-build/export-all.txt). Предыдущий экспорт сохранён отдельно: [export-before-platina.txt](evidence-v05-build/export-before-platina.txt).

Повторный `tsc --noEmit` после SVG подтверждён владельцем компонента как **PASS, exit 0** в [PROFILE_THEME_UI_REPORT.md](PROFILE_THEME_UI_REPORT.md). Отдельный stdout этого повторного запуска не сохранён; старый пустой `typecheck.txt` не выдаётся за новый журнал. Полные **85/85 серверных и 303/303 мобильных теста**, включая 31 E2EE, относятся к снимку до небольшой правки заголовка профиля; точная разница зафиксирована в [platina-build-delta.json](evidence-v05-build/platina-build-delta.json). Подробности и непройденные quality-пороги — [TEST_REPORT.md](TEST_REPORT.md).

Не подтверждены Xcode/Swift compilation, подписанный IPA, установка и обновление на физическом Android, работа на iPhone, визуальное отображение SVG, реальный media path между телефонами или независимый аудит безопасности. Наличие классов и библиотек в APK не заменяет криптографические и аппаратные проверки. Для работы этой версии нужен сервер 0.5; перед миграцией схемы 4 следует сохранить резервную копию DATA_DIR. Инструкции — [DEPLOYMENT.md](DEPLOYMENT.md) и [DEPLOY_FROM_IPHONE.md](DEPLOY_FROM_IPHONE.md).
