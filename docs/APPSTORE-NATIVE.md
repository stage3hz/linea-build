# Нативное приложение для iPhone в App Store

Сборка: GitHub → Actions → **«Native iOS App Store / TestFlight»** (`.github/workflows/native-ios-appstore.yml`) →
Run workflow. Поля: `bundle_id` (по умолчанию `com.invizent.app`), `runner` (по умолчанию `macos-26`).
Тексты карточки, App Privacy и заметки для App Review — в `docs/appstore.md` (те же, что у прежнего приложения).

## Что должно быть заранее

**Секреты GitHub** (Settings → Secrets and variables → Actions) — те же, что для прежнего `ios-appstore.yml`:
- `ASC_KEY_ID`, `ASC_ISSUER_ID` — ключ App Store Connect API (Users and Access → Integrations → App Store Connect API,
  роль App Manager);
- `ASC_KEY_P8` — всё содержимое файла `.p8`, со строками BEGIN/END;
- `APPLE_TEAM_ID` — Team ID (10 символов);
- `ATTEST_KEY` — необязательно (подпись запросов; тот же ключ, что на сервере).

Без любого из первых четырёх сборка сразу останавливается и пишет, какого секрета нет.

**Apple Developer / App Store Connect:**
- App ID `com.invizent.app` с возможностями **Push Notifications** и **App Groups**;
- App ID расширения демонстрации экрана `com.invizent.app.ScreenBroadcast` с **App Groups**;
- App Group `group.com.invizent.app.screen`, включённая у обоих App ID.
  (Xcode с ключом API умеет создать это сам, но надёжнее завести вручную.)
- Запись приложения в App Store Connect (My Apps → «+») с Bundle ID `com.invizent.app`. Если запись уже есть от
  прежнего приложения — новая сборка идёт в неё же.

**Сервер:** push-ключ APNs (`.p8` из Keys с включённым APNs) — `bash deploy/apns.sh /путь/AuthKey_XXXXXXXXXX.p8`,
на вопрос «Bundle ID» ответить `com.invizent.app`. Сервер шлёт push только одному Bundle ID; preview-сборки push
всё равно не получают (у них нет `aps-environment`).

## Что делает сборка

- Bundle ID из поля `bundle_id`, расширение `<bundle_id>.ScreenBroadcast`, App Group `group.<bundle_id>.screen` —
  через настройку `INVIZENT_BUNDLE_ID` в `native/ios/project.yml` (файлы в CI не правятся). Push: `InvizentPush.entitlements`
  (`aps-environment` = production) только у приложения.
- Сервер: `https://api.invizent.com` (зашит в `Sources/Auth/Account.swift`; локальный адрес возможен только в
  симуляторе — сборка это проверяет).
- Версия — `MARKETING_VERSION` из `project.yml` (сейчас 0.17.0), номер сборки — номер запуска workflow.
- Подпись автоматическая, archive → проверка (Bundle ID, версия, номер, entitlements, privacy manifest — без
  секретов, файл `verify.txt` в артефакте `native-ios-appstore-logs`) → экспорт app-store-connect → загрузка.
- Ключ `.p8` лежит только во временной папке раннера и удаляется в конце, даже при ошибке.

## Что проверить в TestFlight

1. Через 10–30 минут сборка появится в App Store Connect → TestFlight. Если висит «Missing Compliance» — ответить
   на вопрос о шифровании (ключ `ITSAppUsesNonExemptEncryption` не задан, как у прежнего приложения; приложение
   использует сквозное шифрование Signal сверх HTTPS — отвечать по анкете Apple).
2. Установить из TestFlight: вход, отправка/получение сообщения, звонок, голосовое и видеосообщение, вложение из
   галереи, сохранение фото (вопросы о разрешениях — по-русски).
3. Push: разрешить уведомления, закрыть приложение, написать с другого устройства — должно прийти уведомление.
   «Уведомления и звуки» не должны говорить «не настроены в этой сборке».
4. Демонстрация экрана в звонке/комнате (расширение «INVIZENT Screen»).
5. Настройки → Оформление → Иконка приложения: все четыре иконки переключаются.
6. Настройки → Безопасность и устройства → «Удалить аккаунт» на месте (требование Apple).

## Важно: это второе приложение рядом с preview

App Store-приложение (`com.invizent.app`) — **другой** Bundle ID, чем установленное вручную preview
(`com.linea.messenger.preview`). Поэтому оно ставится **рядом**, а не поверх: у него свой контейнер данных и своя
связка ключей. Для аккаунта это **новое устройство**: после входа остальные устройства покажут «Новый вход», а
старые переписки придут через перенос истории (с другого своего устройства через 10 минут или из резервной копии —
`docs/HISTORY-TRANSFER.md`). Preview-приложение можно оставить или удалить после того, как переписки пришли.
Preview-сборки (`native-ios-ipa.yml`) по-прежнему собираются с `com.linea.messenger.preview`.

## Лицензии

Приложение содержит код под AGPL-3.0 (ядро `native/core` и libsignal) — см. `THIRD_PARTY_NOTICES.md`. Для каждой
выпущенной сборки исходный код той же версии должен быть доступен пользователям (например, публичный репозиторий
с тегом сборки и ссылка на него в описании или в приложении). Совместимость условий App Store с AGPL для стороннего
кода libsignal — решение владельца (при сомнении — консультация юриста).
