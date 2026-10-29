# Read-only проверка зависимостей 0.5

Дата: 2026-10-28 UTC. Проверены текущие npm lockfiles после добавления media-пакетов. `npm audit fix`, установка, обновление и изменение override не выполнялись. SHA-256 двух `package.json` и двух `package-lock.json` до и после совпали: [снимок](evidence-v05-build/npm-audit-package-lock-hashes.txt).

## Результат npm audit

| Дерево | Info | Low | Moderate | High | Critical | Всего |
|---|---:|---:|---:|---:|---:|---:|
| server | 0 | 0 | 0 | 0 | 0 | **0** |
| mobile | 0 | 5 | 0 | 3 | 0 | **8** |

Исходные JSON: [server](evidence-v05-build/npm-audit-server.json), [mobile](evidence-v05-build/npm-audit-mobile.json). Серверная команда завершилась с exit 0. Мобильная — с exit 1 из-за найденных предупреждений; JSON содержит нормальный audit report, а не сетевую ошибку.

На первом запуске sandbox заблокировал сетевой запрос к registry с `EPERM`. После автоматического разрешения read-only сетевого аудита обе команды получили ответы npm registry. Результаты первоначальной сетевой ошибки заменены успешными отчётами.

Восемь записей мобильного отчёта означают **восемь затронутых пакетов**, а не восемь независимых уязвимостей. В данном дереве два исходных advisory:

| Источник | Установлен | Severity | Путь |
|---|---|---|---|
| `zod` | 3.25.76 | high | `expo@57.0.31 → @expo/cli@57.0.32 → zod` |
| `deepmerge` | 4.3.1 | low | `expo@57.0.31 → @expo/config@57.0.10 → deepmerge` |

Остальные записи распространяют severity по цепочке зависимостей: high также у `@expo/cli` и `expo`; low — у `@expo/config`, `@expo/local-build-cache-provider`, `@expo/metro-config`, `@expo/prebuild-config`. Точное дерево подтверждено локальным `npm ls`: [вывод](evidence-v05-build/npm-audit-mobile-paths.txt).

## Production и инструменты разработки

В lockfile **все 8 затронутых nodes относятся к npm production tree**, не помечены `dev:true`. Поэтому считать результат «только devDependencies» неверно. Expo устанавливает свою CLI и конфигурационные пакеты через обычные dependencies.

Фактически обнаруженные пути относятся к **инструментам разработки и сборки Expo**. В установленном исходном коде `@expo/cli` Zod используется в `start/server/createMCPDevToolsExtensionSchema.js` и `start/server/DevToolsPlugin.schema.js`; `deepmerge` используется в `@expo/config/build/Config.js`. Прямых импортов `zod` или `deepmerge` в `mobile/App.tsx`, `mobile/src`, `mobile/modules`, `app.config.js` не найдено. Это статическая классификация найденных путей: она не заменяет проверку итогового APK/JS bundle и не доказывает недостижимость уязвимого кода во всех сценариях.

У работающего Node-сервера своё дерево зависимостей, в котором npm registry сейчас не сообщил известных уязвимостей. Это ограниченный результат базы advisory, а не заключение об отсутствии ошибок в сервере, E2EE или приложении. Native Maven/CocoaPods, ОС и сторонние сервисы этим npm-аудитом не проверены.

## Что означают два предупреждения

- [Zod, GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): GitHub Reviewed, high. Валидация очень больших коллекций может расходовать память до отказа процесса. База указывает affected `<4.6.6`, исправленную версию `4.6.6`. Для этого проекта конкретная достижимость через Expo dev-server не воспроизводилась. Такой сервер не следует рассматривать как production endpoint мессенджера.
- [deepmerge, GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4): GitHub Reviewed, low. Специально сформированный исходный объект при merge может изменять прототип возвращаемого объекта. В базе affected `>=4.2.0 <=4.3.1`; patched version на момент проверки не указана. Здесь обнаружен путь конфигурации Expo; атака на конкретную сборку не воспроизводилась.

`fixAvailable` npm для основной цепочки предлагает `expo@51.0.39` с `isSemVerMajor:true`. Это существенный откат относительно SDK 57, а не проверенное совместимое исправление текущего приложения. Он не применён. Обновление Zod 3 → 4 также требует проверки совместимости вызывающей CLI; автоматический override не добавлялся.

Текущий вывод: известные остаточные предупреждения мобильного toolchain необходимо сохранить в release report. Результат не устанавливает эксплуатацию в выпущенном клиенте и сам по себе не доказывает необходимость блокировать серверный релиз. Совместимое обновление Expo/toolchain остаётся отдельной задачей после оценки upstream-версий и повторной сборки.

## Совместимость Expo

Выполнено локальной установленной CLI, без `--fix`, с `CI=1`, `EXPO_NO_TELEMETRY=1`, `EXPO_OFFLINE=1`:

```sh
node node_modules/expo/bin/cli install --check
```

**Exit 0**, `Dependencies are up to date`. В том же выводе Expo предупреждает: `Dependency validation is unreliable in offline-mode`. Поэтому результат означает проверку локальной SDK-матрицы; актуальность удалённой Expo-матрицы не подтверждалась. [Полный вывод](evidence-v05-build/expo-install-check.txt).

Команда npm-аудита для каждого каталога:

```sh
npm audit --json --fetch-retries=0 --fetch-timeout=30000
```

Использован отдельный временный npm cache вне проекта. Source, версии и lockfiles оставлены неизменными.
