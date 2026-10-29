# Evidence: video v0.5

Эта папка содержит фактические результаты ограниченного native-video/MP4 scope. Главный отчёт — [VIDEO_NATIVE_REPORT.md](../VIDEO_NATIVE_REPORT.md).

## Файлы

- `logs/jvm-*.txt/xml`: исходные RED→GREEN циклы и финальные 13 JVM-тестов production NAL/SPS-парсера.
- `logs/android-final-compile.txt`: отдельная Kotlin + Java компиляция Android-модуля. Не полная APK и не устройство.
- `logs/mp4-red.txt`, `mp4-green.txt`, `mp4-aac-red.txt`, `mp4-aac-green.txt`: воспроизведение privacy defects и исправления.
- `logs/mp4-final-coverage-tests.txt`, `mp4-final.lcov`: 26 тестов через прямой `.ts` import и точные позиции исходников.
- `logs/mp4-crap-{initial,refactor,final}.txt`, `mp4-crap.edn`: начальная метрика, промежуточный рефакторинг и финальный Crapper <10. Название промежуточного журнала — `mp4-crap-refactor.txt`.
- `logs/mp4-mutation-first.txt`: исторический первый Mutator на 18 тестах: 362 killed, 160 survived, 2 uncovered / 524; 69.3%.
- [Финальный MP4 Mutator](../media-quality/mp4-mutation-final.txt): полный повторный запуск на 26 тестах — **431 killed, 93 survived, 0 uncovered / 524; 82.3%, exit 3**. **Mutation-gate не пройден.** EDN: [mp4](../media-quality/mp4-mutation-results/media.mp4.edn), [mp4Boxes](../media-quality/mp4-mutation-results/media.mp4Boxes.edn), [mp4Samples](../media-quality/mp4-mutation-results/media.mp4Samples.edn). Production SHA-256 совпадает со staging. `quality-summary.json` сохраняет предыдущий исторический срез; актуальный mutation-итог находится в указанных финальных файлах.
- `logs/mp4-refactor-boundary-coverage-tests.txt`: исторический запуск 18 тестов до разбора мутаций.
- `logs/mp4-dry-final.txt`, `mp4-dry.edn`: реальный Dryer, 0 кандидатов при 0.8.
- `logs/*-native.txt`: фактический отказ обнаружения Kotlin/Swift инструментами. Это не 100% coverage и не успешная mutation-проверка.
- `fixtures/sdr.h264`, `hdr10.hevc`: реальные исходные кодированные потоки; идентичные экземпляры доступны в JVM test resources.
- `fixtures/clean-*`: результат production Kotlin `VideoNal.cleanAnnexB` из JVM-теста.
- `fixtures/native-like-*.mp4`: representative FFmpeg-контейнеры, не захват выхода Android/iOS.
- `fixtures/final-*.mp4`: выход финального JS-санитайзера для этих файлов.
- `decoder-verification.json`: результат независимого декодирования и проверок метаданных.
- `source-manifest.json`: SHA-256 исходников scope на момент freeze; `artifact-sha256.json`: SHA-256 fixture/log artifacts.

## Быстрая повторная проверка MP4 и декодирования

Из корня проекта, Node 24+, FFmpeg и ffprobe в PATH:

```sh
node --test --test-isolation=none mobile/test/media-mp4.test.mjs
node docs/evidence-v05-video/verify-mp4.mjs
```

Вторая команда снова создаёт `final-*.mp4` и `decoder-verification.json`. Она сравнивает реальные декодированные кадры, HDR side data и PCM, требует два кадра, проверяет идемпотентность и отсутствие личных тегов. Сравнение PCM относится только к очистке MP4; оно не измеряет качество нативного lossy AAC-перекодирования.

## JVM и Android

Команды, использованные в подготовленной среде, из `mobile/android`:

```sh
JAVA_HOME=/tmp/linea-jdk21 GRADLE_USER_HOME=/tmp/linea-gradle-cache LINEA_VIDEO_FIXTURE_OUT=/tmp/linea-video-quality/fixtures ./gradlew -p ../modules/linea-video/jvm-tests test --max-workers=2 --no-daemon
JAVA_HOME=/tmp/linea-jdk21 ANDROID_HOME=/tmp/linea-android-sdk GRADLE_USER_HOME=/tmp/linea-gradle-cache ./gradlew :linea-video:compileReleaseKotlin :linea-video:compileReleaseJavaWithJavac --max-workers=2 --no-daemon
```

JVM source set включает только `VideoPolicy`, `VideoNal`, `VideoBits` и реальные тесты, без Android stubs. Экспорт `clean-*` находится в тесте `actualEncodedFramesAndHdrRemainByteIdenticalAfterPrivateSeiRemoval`. При повторном экспорте в новый каталог нужны существующий каталог и повторное выполнение, а не Gradle `UP-TO-DATE`.

Gradle потребовал разрешённый запуск вне ограничения sandbox loopback-file-lock. Использовались только узкие compile/test задачи; prebuild и полная APK в этом scope не запускались.

## Crapper / Dryer / TypeScript

В `/tmp/linea-mp4-quality/project` скопированы только три production TS-файла, тест, `mp4-fixture.mjs`, native test resource files и минимальный `package.json`. Анализ не расширялся на старый сервер. Из staging:

```sh
node --test --test-isolation=none --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info --test-reporter=spec --test-reporter-destination=stdout mobile/test/media-mp4.test.mjs
XDG_CACHE_HOME=/tmp/linea-quality-tools/cache /tmp/linea-quality-tools/venv/bin/crapper --root /tmp/linea-mp4-quality/project --use-existing-coverage --threshold 9.999 mobile/src/media/mp4.ts mobile/src/media/mp4Boxes.ts mobile/src/media/mp4Samples.ts
XDG_CACHE_HOME=/tmp/linea-quality-tools/cache /tmp/linea-quality-tools/venv/bin/dryer --root /tmp/linea-mp4-quality/project --threshold 0.8 mobile/src/media/mp4.ts mobile/src/media/mp4Boxes.ts mobile/src/media/mp4Samples.ts
```

Из `mobile` production checkout:

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module preserve --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck src/media/mp4.ts src/media/mp4Boxes.ts src/media/mp4Samples.ts
```

Нативные Crapper/Dryer/Mutator запускались на отдельной `/tmp/linea-video-quality/tools-scope` с копиями только Kotlin/Swift. Инструменты не обнаружили поддерживаемых source files. Данные логов сохранены без преобразования в фиктивный quality PASS.

## Происхождение видеофикстур

Использован системный FFmpeg 6.1.1 с libx264/libx265. Короткие одноцветные видео созданы локально, без чужих пользовательских видео.

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=blue:s=64x48:r=5 -t 0.4 -pix_fmt yuv420p -c:v libx264 -threads 1 -x264-params repeat-headers=1 -f h264 sdr.h264
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=red:s=64x48:r=5 -t 0.4 -pix_fmt yuv420p10le -c:v libx265 -threads 1 -x265-params 'pools=1:frame-threads=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400' -f hevc hdr10.hevc
```

После production Kotlin фильтра:

```sh
ffmpeg -hide_banner -loglevel error -fflags +genpts -r 5 -i clean-sdr.h264 -c copy -avoid_negative_ts make_zero -movflags +faststart native-like-sdr.mp4
ffmpeg -hide_banner -loglevel error -fflags +genpts -r 5 -i clean-hdr10.hevc -c copy -avoid_negative_ts make_zero -tag:v hvc1 -movflags +faststart -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc native-like-hdr10.mp4
ffmpeg -hide_banner -loglevel error -i native-like-sdr.mp4 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.6 -c:v copy -c:a aac -b:a 128k -metadata title='private title' -metadata location='+55.1234+037.5678/' -metadata comment='private location' -metadata creation_time='2025-12-04T09:10:00Z' -avoid_negative_ts make_zero -movflags +faststart native-like-audio.mp4
```

При первоначальном remux raw-потоков без `-avoid_negative_ts make_zero` временная шкала скрывала один кадр. Это исправлено в final fixtures, а в проверочный скрипт добавлено требование двух декодированных кадров и сравнение с исходным raw digest. Эта проблема касалась построения проверочных контейнеров через FFmpeg, а не изменения production нативного кода. Нативные тестовые ресурсы после freeze не менялись.

## Границы свидетельств

Результат включает код, JVM-парсер, Android compile, JS MP4 tests и независимый software decode. Здесь нет успешного `xcodebuild`, аппаратного Android codec run, видеозвонка, Photos/iCloud runtime или проверки полной приложения на телефоне. Общая сборка APK идёт отдельным scope. Первый mutation-результат 69.3% сохранён как исторический; финальный полный запуск после расширения до 26 тестов дал 82.3%, exit 3. Mutation-gate не пройден. Уцелевшие 93 мутации не объявляются все эквивалентными; неподтверждённые метрики не считаются пройденными.
