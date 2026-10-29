# Проверка PNG перед отправкой — Linea 0.4.0

Дата: **28 октября 2026 года**. Область: `mobile/src/photo/png.ts`, `mobile/test/photo-png.test.mjs`; вспомогательный генератор PNG в `mobile/test/support/png-fixture.mjs` использован без изменений. Нативный рендер, очередь отправки, интерфейс, криптография и сервер не входят в этот отчёт.

**Итог: 71 из 71 теста прошли; строгая проверка TypeScript прошла.** Реальные Crapper и Dryer прошли в указанной области. Последний запуск Mutator обнаружил и выполнил 113 мутаций: 113 killed, 0 survived, 0 uncovered. Все эти числа относятся к одному PNG-модулю и операторам конкретных инструментов, а не ко всему приложению или полноте проверки безопасности. Исходные журналы, LCOV, EDN и контрольные суммы сохранены в [photo-quality](photo-quality/source-manifest.json).

## Контракт обработки

Sanitizer получает результат обязательного нативного **decode → преобразование пикселей в 8-bit sRGB → новое кодирование PNG**. Его задача — проверить контейнер и оставить только `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND`. Остальные ancillary chunks удаляются, неизвестные critical chunks отклоняются. CRC проверяется до удаления, в том числе у удаляемых блоков. APNG `acTL`/`fcTL`/`fdAT` отклоняются явно.

Проверяются сигнатура, границы блоков, заголовок, сочетание цвета и глубины, порядок сохраняемых блоков, последовательность `IDAT`, обязательная палитра для индексного изображения, размеры палитры и прозрачности, конец файла и лимиты. Ограничения: **20 МиБ**, **16 000 000 пикселей**, сторона до **20 000 px**, до **4096 блоков** включительно. `hasAlpha` означает наличие alpha-канала или таблицы/ключа прозрачности; оно не означает, что в изображении обязательно есть полупрозрачный пиксель.

Этот модуль **не распаковывает zlib**, не проверяет корректность каждой строки растра и не ищет информацию в пикселях, неиспользованных записях палитры или содержимом `IDAT`. Он не заменяет нативное декодирование и новое кодирование. В частности, спецификация допускает игнорируемые декодером байты в конце последнего `IDAT`; простого удаления EXIF недостаточно для их устранения. Требования к последовательности блоков и прозрачности сверены с [PNG Third Edition, §5.6](https://www.w3.org/TR/png-3/#5ChunkOrdering), [§11.2.3 IDAT](https://www.w3.org/TR/png-3/#11IDAT), [§11.3.1.1 tRNS](https://www.w3.org/TR/png-3/#11tRNS).

Удаление `iCCP`, `gAMA` и других цветовых описаний безопасно для выбранного продуктового пути только после преобразования пикселей в согласованный sRGB. Сравнение пикселей ниже проверяет сам sanitizer; оно не является проверкой преобразования цвета на iPhone или Android. Обязательная структура PNG, размеры, палитра при необходимости и CRC сохраняются, поэтому буквальное обещание «файл вообще без метаданных» было бы неточным.

## Найденные проблемы и изменения

### 1. Порядок PLTE и tRNS — исправленный дефект

Исходная реализация принимала truecolor PNG с `tRNS`, после которого шла необязательная `PLTE`. По таблице порядка PNG палитра, если присутствует, должна предшествовать прозрачности. Сначала добавлен воспроизводящий тест `a suggested truecolor palette cannot appear after its transparency chunk`. Он упал с `Missing expected exception`: [RED, 1/1 FAIL](photo-quality/png-order-red.log). Затем в `acceptPalette` добавлена проверка уже встреченной прозрачности. После исправления прошли все имевшиеся 22 теста: [GREEN, 22/22](photo-quality/png-order-green.log).

Сохранены [исходный код до review](photo-quality/png-source-before-review.ts.txt) и [его контрольные суммы](photo-quality/initial-sources.json). Неверный порядок теперь отклоняется, корректный truecolor `PLTE → tRNS → IDAT` отдельно проверяется положительным тестом.

### 2. Строгая типизация — исправленные ошибки сборки

TypeScript 6.0.3 обнаружил несовместимость выведенного `Uint8Array<ArrayBuffer>[]` с блоками `Uint8Array<ArrayBufferLike>` и обращения к полям `Header | null`. Массив частей получил явный тип `Uint8Array[]`; завершённый заголовок сужается локальной проверкой с `return fail(...)`. Ослабление `strict`, приведение через `any` или подавление ошибок не применялось.

Контрольная компиляция первоначального файла воспроизводит ошибки TS2345/TS2339: [RED compiler log](photo-quality/png-typecheck-red.log). Финальная команда завершилась с кодом 0; отсутствие вывода нормально для `tsc`: [GREEN compiler log](photo-quality/png-typecheck-green.log), [статус и версии](photo-quality/source-manifest.json). При явной передаче файла в TypeScript 6 используется `--ignoreConfig`, чтобы этот отдельный прогон не подменял проверку всей мобильной сборки.

### 3. Упрощение после измерения сложности

Первый Crapper после исправления порядка показал три функции выше требуемого CRAP <10: `readHeader` — 12, `sanitizePng` — 12, `acceptPalette` — 11. Разделены проверка размеров, проверка содержимого палитры и обход контейнера. Получились `validateDimensions`, `paletteEntries`, `collectChunks`, а публичный `sanitizePng` сохраняет сигнатуру и поведение. Все 66 уже добавленных поведенческих тестов проходили до и после этого разделения.

Затем удалён избыточный локальный guard `chunkLength > MAX_BYTES`: полный файл уже ограничен 20 МиБ до парсинга, а `chunkEnd > bytes.length` отклоняет любой блок, не помещающийся в файл. Это не расширяет допустимый размер. Именно недостижимая отдельно граница стала одним из survivors первого mutation-прогона. Проверки общего размера и конца блока остались, обе имеют граничные тесты.

Сравнение: [Crapper до](photo-quality/png-crap-before-refactor.txt), [код до разделения](photo-quality/png-source-before-refactor.ts.txt), [Crapper после](photo-quality/png-crap.txt).

## Поведенческие проверки

Финальный набор вырос с 21 до 71 теста. Первоначальные тесты сохранены; проверки новых границ добавлены без подмены реализации тестовыми заглушками. Генератор получает CRC и deflate от `node:zlib`, а production sanitizer использует собственное вычисление CRC.

| Группа | Проверенные случаи |
|---|---|
| Очистка | EXIF, текст/GPS, XMP-подобное содержимое, дата, профиль, параметры отображения, частный ancillary chunk; CRC повреждённого удаляемого блока также вызывает отказ |
| Пиксели | Все 15 поддержанных сочетаний color type / bit depth: grayscale 1/2/4/8/16, RGB 8/16, indexed 1/2/4/8, gray+alpha 8/16, RGBA 8/16; распакованные строки совпадают с ожидаемыми |
| Прозрачность | Полный alpha, grayscale/RGB `tRNS`, короткая индексная таблица, максимальная палитра/таблица; байты `PLTE`/`tRNS` сохраняются |
| Контейнер | Неизвестный critical chunk, незаконное имя, зарезервированный бит имени, неправильный первый блок, дубли заголовка/палитры/прозрачности, несовместимые блоки, поздняя палитра/прозрачность |
| IDAT / IEND | Несколько последовательных `IDAT`, в том числе пустые; прерванная последовательность; отсутствие данных; непустой `IEND`; отсутствие `IEND`; лишние данные после него |
| Ошибочные размеры | Частичный заголовок блока длиной 1–11 байт; слишком большая объявленная длина, выходящая за файл; нулевые размеры; превышение каждого рабочего лимита |
| Границы | Ровно 20 МиБ, ровно 4096 блоков, 4000×4000 пикселей, сторона ровно 20 000; соответствующее превышение отклоняется |
| Совместимость | Неподдержанные алгоритмы и цвета отклоняются; определённый флаг Adam7 сохраняется в корректном однопиксельном примере; APNG отклоняется с любым из трёх animation chunks |
| Память и повторная обработка | `Uint8Array` с ненулевым смещением не захватывает соседние байты; новый output не разделяет память с input; повторная очистка даёт байт-в-байт тот же PNG |

Последние пять тестов добавлены после анализа шести survivors: неполный заголовок, ограниченная, но выходящая за файл длина, пустая/слишком большая необязательная truecolor-палитра и однобайтовая индексная прозрачность. Они уточняют правильное существовавшее поведение. Для проверок обрезанных данных дополнительно требуется контролируемая ошибка PNG, а не случайный `RangeError` чтения за границей массива.

Полный результат: [71/71 + coverage](photo-quality/png-coverage-tests.log), [LCOV](photo-quality/png-coverage.lcov). Node сообщает для `png.ts` 100% строк, ветвей и функций в этом прогоне. Это показатель инструментального покрытия данного файла, а не доказательство отсутствия всех дефектов.

## Независимое декодирование пикселей

Четыре дополнительные пары PNG декодированы **Pillow 12.3.0**, независимо от JS parser и распаковки в unit-тестах:

| Сценарий | Проверенный результат после конвертации декодером в RGBA |
|---|---|
| RGBA, 2×2 | Четыре разных цвета; alpha 0, 127, 255, 254 совпадает с ожидаемой |
| Indexed, короткая tRNS | Первый индекс прозрачный, отсутствующая в таблице alpha второго индекса — 255 |
| Grayscale tRNS | Значение 123 прозрачно, соседнее 124 непрозрачно |
| Truecolor tRNS | Цвет (20,40,60) прозрачен, (20,40,61) непрозрачен |

Для всех четырёх пар декодированные пиксели исходника, результата и ожидаемого массива совпали. `Author` присутствовал до очистки и отсутствовал после. Таблица прозрачности остаётся в `image.info` у соответствующих PNG, поскольку необходима для изображения. Также проверена идемпотентность sanitizer. Полные массивы, SHA-256 PNG и результаты: [pixel-decoder-check.json](photo-quality/pixel-decoder-check.json). Воспроизводимые генератор и проверка: [pixel-fixtures.mjs](photo-quality/pixel-fixtures.mjs), [verify-pixels.py](photo-quality/verify-pixels.py).

## Реальные quality gates

Инструменты запускались на отдельной копии из трёх указанных source/test файлов и минимального `package.json`. Crapper/Dryer анализировали **только `mobile/src/photo/png.ts`**; Mutator менял только staging-копии и выполнял настоящий Node test runner. Production source не мутировался. Исходные и проверенные staging-файлы побайтово сверены после последнего прогона.

| Проверка | Фактический результат | Доказательство |
|---|---|---|
| TypeScript strict | exit 0 | [manifest](photo-quality/source-manifest.json), [log](photo-quality/png-typecheck-green.log) |
| Node tests | 71 passed, 0 failed, 0 skipped | [log](photo-quality/png-coverage-tests.log) |
| Crapper | 16 функций, максимальный CRAP 8; все <10 | [text](photo-quality/png-crap.txt), [EDN](photo-quality/png-crap.edn) |
| Dryer | 0 кандидатов при threshold 0.8 | [text](photo-quality/png-dry.txt), [EDN](photo-quality/png-dry.edn) |
| Mutator, первый полный прогон | 109 killed / 115 sites; 6 survived; 0 uncovered; exit 3 | [text](photo-quality/png-mutation-first.txt), [EDN](photo-quality/png-mutation-first.edn) |
| Mutator, финальный прогон | 113 killed / 113 sites; 0 survived; 0 uncovered; exit 0 | [text](photo-quality/png-mutation.txt), [EDN](photo-quality/png-mutation.edn) |
| Pillow | 4/4 совпадения пикселей и alpha | [JSON](photo-quality/pixel-decoder-check.json) |

Финальная mutation-оценка 100% означает только уничтожение всех 113 операторов, которые нашёл установленный Mutator. Число сайтов уменьшилось со 115 до 113 после удаления избыточного условия. Инструмент классифицирует неуспешное выполнение мутанта, включая ошибки компиляции/тайм-аут, как killed; это не перебор всех возможных изменений кода. В частности, не заявляется исчерпывающая мутация глобального инициализатора таблицы CRC. Дополнительное искусственное изменение метрик не применялось.

Версии: Node **24.22.1**, TypeScript **6.0.3**, Python **3.12.14**, Pillow **12.3.0**. У всех трёх quality tools package version **0.1.0**; фактические ревизии:

- Crapper: `6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d`.
- Dryer: `66ff6d21a42c04afcad89c78a80066176d1294b0`.
- Mutator: `a5a0cb803b66e0cdb8bf471b3b08af701d424a41`.

Контрольная сумма финального `png.ts`: `fa47d3ec2450c8f0d08c99011aead54a9eee673ece928f5e7b923bf4714f6708`. Полный [source manifest](photo-quality/source-manifest.json) фиксирует также тесты и fixture helper.

## Повторение проверок

Unit-тесты из корня проекта, в Node 24:

```sh
node --test --test-isolation=none mobile/test/photo-png.test.mjs
```

Отдельная строгая проверка файла из `mobile`:

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module preserve --skipLibCheck src/photo/png.ts
```

В уже подготовленном изолированном `/tmp/linea-photo-quality/project`, с существующим каталогом `coverage`, использовались:

```sh
node --test --test-isolation=none --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info --test-reporter=spec --test-reporter-destination=stdout mobile/test/photo-png.test.mjs
XDG_CACHE_HOME=/tmp/linea-quality-tools/cache /tmp/linea-quality-tools/venv/bin/crapper --root /tmp/linea-photo-quality/project --use-existing-coverage --threshold 9.999 mobile/src/photo/png.ts
XDG_CACHE_HOME=/tmp/linea-quality-tools/cache /tmp/linea-quality-tools/venv/bin/dryer --root /tmp/linea-photo-quality/project --threshold 0.8 mobile/src/photo/png.ts
XDG_CACHE_HOME=/tmp/linea-quality-tools/cache /tmp/linea-quality-tools/venv/bin/mutator --root /tmp/linea-photo-quality/project --use-existing-coverage --mutate-all --max-workers 2 --test-command 'node --test --test-isolation=none mobile/test/photo-png.test.mjs' mobile/src/photo/png.ts
```

Проверка внешним декодером из корня проекта; требуется указанная версия Pillow:

```sh
node docs/photo-quality/pixel-fixtures.mjs /tmp/linea-photo-quality/pixel-fixtures
python docs/photo-quality/verify-pixels.py /tmp/linea-photo-quality/pixel-fixtures
```

## Практические ограничения результата

Не выполнялись fuzzing, проверка расхода памяти на телефонах, аудит нативных декодеров, проверка iOS runtime, оценка качества удаления фона или сквозная отправка вложения между устройствами. Границы самого photo pipeline и очистка временных файлов проверяются отдельно. Новый `png.ts` нельзя использовать как самостоятельную гарантию удаления скрытого содержимого из произвольного загруженного PNG. Git commit/push для этой работы не выполнялись; сохранены исходные файлы, журналы и контрольные суммы.
