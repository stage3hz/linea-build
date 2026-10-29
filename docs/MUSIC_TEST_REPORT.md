# Проверка музыки в Линии 0.2.0

Дата проверки: 27 октября 2026 года.

## Автоматические проверки каталога

**Результат: 11 тестов прошли, 0 ошибок, 0 пропусков.**

Файл: `mobile/test/music-catalog.test.mjs`.

Команда из каталога `mobile`:

```bash
npm run test:music
```

Скрипт выполняет:

```bash
node --test test/music-catalog.test.mjs
```

Среда: Node.js 24.22.1, npm 11.9.0, Linux. Длительность контрольного прогона — 176,23 мс, код завершения — 0. Node использует встроенное удаление TypeScript-аннотаций при импорте `src/music/catalog.ts`. Metro, React Native, устройство и внешний музыкальный сервис для этих тестов не запускаются.

Тесты подают независимые примеры метаданных провайдера в публичные функции адаптера. Они проверяют решения о доступе и результаты страниц, а не повторяют алгоритм реализации.

| № | Сценарий | Подтверждённый результат |
|---|---|---|
| 1 | Явно открытый трек и трек только для прослушивания | Публичный трек доступен; право прослушивания само по себе не даёт права скачивания |
| 2 | Платные условия, gates, недоступность, удаление, unlisted, API allowlist и access authority | Такие записи не становятся доступными для прослушивания или скачивания и исключаются из отображаемого каталога |
| 3 | Отсутствующие, неизвестные и строковые значения обязательных флагов доступа | Значения не приводятся к `true`; доступ закрывается, неверные типы данных не вызывают падение |
| 4 | Независимые требования скачивания | Нужны явный download grant, разрешённый доступ, отсутствие gate/условий и безопасный HTTPS URL; поисковая метка не заменяет эти условия |
| 5 | Конфликт старого и нового полей скачивания | Legacy `downloadable: true` не перекрывает явный отказ или неоднозначное значение `is_downloadable` |
| 6 | Небезопасные URL | Отклоняются HTTP, file/data/javascript, credentials, нестандартный порт, локальные имена, приватные IPv4/IPv6 и замаскированные формы IPv4 |
| 7 | Небезопасная ссылка stream в метаданных | Такая ссылка не попадает в нормализованный доступный трек |
| 8 | Режим «можно скачать» | Каждая запись всё равно проходит независимые проверки прав; `downloadableOnly` не открывает заблокированный контент |
| 9 | Полная исходная страница без доступных после фильтрации треков | Следующая страница остаётся доступной, в том числе при фильтре скачивания |
| 10 | Короткая/пустая исходная страница и неверная форма ответа | Пагинация завершается; ответ, который не является массивом, отклоняется |
| 11 | Повторяющиеся записи | В результатах нет дубликатов, а позиция следующей страницы учитывает исходную страницу и не застревает |

В контрольном прогоне были два предупреждения среды: существующий npm `http-proxy` и Node `MODULE_TYPELESS_PACKAGE_JSON` для импортируемого TypeScript-файла. Они не изменили результат тестов. Проект не переводился в ESM ради подавления предупреждения: его `app.config.js` использует CommonJS.

## Что эти тесты не подтверждают

- Тесты не обращаются к Audius. Они не подтверждают текущую доступность сервиса, полноту каталога, фактическое воспроизведение или получение конкретного файла.
- Поле `downloadable` описывает разрешение в метаданных провайдера. Оно не является юридическим заключением о лицензии и не даёт само по себе права бессрочно хранить данные, полученные через API.
- Проверка URL оценивает его синтаксис и адрес. Она не выполняет DNS-запрос и не доказывает безопасность всех последующих HTTP-перенаправлений; сетевой адаптер должен отдельно получать актуальный URL из официального API.
- Эти проверки не запускают плеер, не измеряют звук, не проверяют управление с экрана блокировки, переключение Bluetooth/наушников, аудиофокус, работу после сворачивания приложения или перезапуска телефона.
- Сервер сообщений не менялся в этой итерации. Этот отчёт не заменяет серверный `TEST_REPORT.md`.

## Статическая проверка интеграции и локальных файлов

Дополнительно прочитаны `src/music/api.ts`, `MusicProvider.tsx` и `PlayerControls.tsx`:

- Перед разрешением stream/download адаптер заново получает трек из официального API и повторно проверяет права. Флаг из старого результата поиска не заменяет новую проверку.
- Audius-аудио не сохраняется в локальную библиотеку: разрешённое скачивание открывается через официальный endpoint во внешнем браузере. В избранном сохраняются ID провайдера; его метаданные восстанавливаются запросом.
- Локальные файлы копируются в частный каталог приложения; имена файлов в индексе проверяются перед доступом. Для незавершённых операций используются проверки жизненного цикла и поколения воспроизведения.
- Найдена и исправлена владельцем кода ошибка импорта: `File.move()` меняет URI самого объекта временного файла. Прежний `finally` мог удалить уже перемещённый файл. После успешного перемещения ссылка `temp` теперь сбрасывается; очистка `completed` выполняется только при неудачной записи индекса. Семантика `move()` сверена с установленным исходным кодом `expo-file-system`, исправление повторно прочитано.

Это проверка исходного кода. Импорт и проигрывание на Android/iPhone фактически не запускались.

## Android: подготовка native-конфигурации

Для музыкальной итерации установлена совместимая с Expo SDK 57 версия `expo-audio` 57.0.5. Конфигурация приложения — 0.2.0, Android `versionCode: 2`.

Выполнена команда из `mobile`:

```bash
NODE_ENV=production APP_ENV=preview \
node node_modules/expo/bin/cli prebuild \
  --platform android --no-install --no-clean
```

Команда завершилась успешно, существующий каталог `android` использован повторно, `package.json` не изменён. После подготовительной Gradle-сборки проверен также **объединённый release manifest**, а не только исходный XML. Подтверждены версия 0.2.0, versionCode 2, пакет `com.linea.messenger.preview` и:

- `android.permission.FOREGROUND_SERVICE`;
- `android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK`;
- `expo.modules.audio.service.AudioControlsService`, `exported=false`, `foregroundServiceType=mediaPlayback`;
- отсутствие `android.permission.RECORD_AUDIO`, `android.permission.FOREGROUND_SERVICE_MICROPHONE` и `android.permission.CAMERA` в объединённом manifest.

**Подготовительный native-прогон завершился успешно: 37 с, 101 задача, код завершения 0.** Использованы сохранённые JDK Corretto 17.0.21, Android SDK/Build Tools 36/36.0.0, NDK 27.1.12297006, CMake 3.22.1 и Gradle 9.3.1.

Команда из `mobile/android`:

```bash
NODE_ENV=production \
APP_ENV=preview \
JAVA_HOME=/workspace/scratch/f1956a5cefad/android-toolchain/jdk17 \
ANDROID_HOME=/workspace/scratch/f1956a5cefad/android-toolchain/sdk \
ANDROID_SDK_ROOT=/workspace/scratch/f1956a5cefad/android-toolchain/sdk \
GRADLE_USER_HOME=/tmp/linea-android-gradle-qa \
CMAKE_BUILD_PARALLEL_LEVEL=2 \
./gradlew :app:processReleaseMainManifest :app:checkReleaseAarMetadata \
  :expo:compileReleaseKotlin :expo:compileReleaseJavaWithJavac \
  -PreactNativeArchitectures=arm64-v8a \
  -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts \
  --project-cache-dir /tmp/linea-android-project-cache-qa \
  --no-daemon --max-workers=2 --console=plain
```

В процессе подготовки обнаружены и устранены проблемы:

1. npm подтянул peer `expo-asset` 58.0.18, несовместимый с Expo SDK 57 autolinking. В зависимостях явно закреплена совместимая версия `~57.0.20`; повторный autolinking не содержит publication без version.
2. Попытка выполнить `app:compileReleaseKotlin` с исключённым JS bundling остановилась на зависимости `packageReleaseResources`. Для подготовки выбран набор задач manifest/AAR/Expo. Gradle при этом сам запустил JS bundling как зависимость manifest: создан промежуточный bundle из 755 модулей. Перед итоговой сборкой этот generated bundle удалён и создан заново после freeze исходников.

В журнале остаются предупреждения сторонних Gradle/Kotlin API и manifest merger; ошибок в успешном прогоне нет. Подпись, выравнивание и содержимое новой APK этим подготовительным запуском не проверялись, поскольку задача сборки APK ещё не выполнялась.

## Итоговая Android APK 0.2.0

**Финальная сборка выполнена успешно после freeze исходников.** Получен явный код завершения 0 и `BUILD SUCCESSFUL in 1m 17s`: 316 задач, 62 выполнены, 254 использовали актуальные результаты. Кратковременный сбой подключения к среде не принят за успех: после восстановления повторно прочитан сохранённый результат сборки и проверен сам APK.

Команда из `mobile/android`:

```bash
NODE_ENV=production \
APP_ENV=preview \
JAVA_HOME=/workspace/scratch/f1956a5cefad/android-toolchain/jdk17 \
ANDROID_HOME=/workspace/scratch/f1956a5cefad/android-toolchain/sdk \
ANDROID_SDK_ROOT=/workspace/scratch/f1956a5cefad/android-toolchain/sdk \
GRADLE_USER_HOME=/tmp/linea-android-gradle-qa \
CMAKE_BUILD_PARALLEL_LEVEL=2 \
./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts \
  --project-cache-dir /tmp/linea-android-project-cache-qa \
  --no-daemon --max-workers=2 --console=plain
```

Перед запуском удалён только сгенерированный `android/app/build/generated/assets/react/release/index.android.bundle`. В журнале финального запуска подтверждено повторное выполнение `createBundleReleaseJsAndAssets`: 755 модулей. SHA-256 всех 28 зафиксированных файлов исходников, настроек, зависимостей и ресурсов совпали до и после сборки.

| Параметр | Проверенное значение |
|---|---|
| Итоговый файл | `/workspace/scratch/f1956a5cefad/linea-android-arm64-preview.apk` |
| Версия | 0.2.0, versionCode 2 |
| Идентификатор | `com.linea.messenger.preview` |
| Размер | 32 839 255 байт / 31,32 MiB |
| Архитектура | Только `arm64-v8a` |
| minSdk / targetSdk | 24 / 36 |
| Встроенный bundle | `assets/index.android.bundle`, 1 881 856 байт; присутствует код музыкальной библиотеки |
| Подпись | Android Debug, APK Signature Scheme v2; только preview |
| ZIP | Проверка CRC всех записей прошла |
| Выравнивание APK | `zipalign -c -P 16 4` завершился с кодом 0 |
| Сервис аудио | `AudioControlsService` найден в скомпилированном manifest и DEX, `exported=false`, тип `mediaPlayback` |
| Разрешения | Foreground service/media playback присутствуют; RECORD_AUDIO, foreground microphone и CAMERA отсутствуют |

SHA-256 итогового APK:

```text
c14e33f3f4662de79d6149bd8cc774a4a411d7c0a87865663d9609d0bf16f883
```

SHA-256 встроенного bundle:

```text
f72db381efc9c85d3d9b649b66ea14fe60d0cbbfa73417c919f3f447055e1378
```

Для проверки использованы `aapt dump badging`, `aapt dump xmltree`, `apksigner verify --verbose --print-certs`, `zipalign -c -P 16 4` из Build Tools 36.0.0 и стандартный Python `zipfile` для CRC/содержимого. После копирования в итоговый путь SHA-256 проверен повторно.

### Совместимость с прежним preview

Сертификат напрямую сравнен с сохранённой APK 0.1.0: он совпадает. SHA-256 сертификата:

```text
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

Идентификатор пакета остался тем же, versionCode повышен с 1 до 2. На уровне пакета и подписи новая APK совместима с обновлением поверх этого preview 0.1.0. Фактическая установка/обновление на телефоне или эмуляторе не выполнялись.

### Пределы итоговой проверки

Сборка и проверки файла не подтверждают качество звука, импорт на реальном устройстве, фоновое воспроизведение, поведение при блокировке экрана, аудиофокус или взаимодействие с ограничениями энергосбережения конкретного телефона. Проверка ZIP-выравнивания также не заменяет запуск на устройстве с соответствующим размером страницы памяти. iOS native-сборка и запуск на iPhone в этой задаче не выполнялись.

Справка по native background playback: [официальная документация Expo Audio для SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/audio/).
