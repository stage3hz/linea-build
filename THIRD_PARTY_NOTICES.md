# Сторонние компоненты

## libsignal 0.106.0

Нативный модуль `mobile/modules/linea-signal` использует официальный проект
[signalapp/libsignal](https://github.com/signalapp/libsignal/tree/v0.106.0):
`org.signal:libsignal-client:0.106.0`, `org.signal:libsignal-android:0.106.0`
на Android и `LibSignalClient` v0.106.0 на iOS. Node-пакет той же версии
используется только в тестах, не входит в сервер или JavaScript приложения.

Лицензия upstream — GNU Affero General Public License version 3. Полный
текст сохранён в `licenses/libsignal-AGPL-3.0.txt`. Исходники собственного
bridge, всех изменённых частей приложения, скрипты сборки и зафиксированные
зависимости передаются вместе с проектом. Бинарные SDK загружаются из
официальных источников; их исходники доступны по указанному тегу.

Это приложение не является продуктом Signal. Наличие libsignal не означает
одобрение приложения Signal или независимый аудит нашей интеграции.
Перед распространением учитывайте условия AGPL и лицензии остальных
зависимостей; это не разрешение сделать закрытый производный компонент.

## Expo, React Native и остальные зависимости

Точные версии закреплены в `mobile/package-lock.json` и
`server/package-lock.json`. Лицензии каждого пакета находятся в его
распространяемых метаданных и файлах LICENSE; настоящая заметка не заменяет
их условия. Native SQLCipher включается плагином `expo-sqlite`.

## Нативная обработка фото в 0.4.0

Собственный модуль `mobile/modules/linea-photo` подключает на Android:

- `androidx.exifinterface:exifinterface:1.4.1` — чтение ориентации исходного изображения; [официальная страница AndroidX](https://developer.android.com/jetpack/androidx/releases/exifinterface).
- `com.google.android.gms:play-services-mlkit-subject-segmentation:16.0.0-beta1` — отделение переднего плана; [документация ML Kit](https://developers.google.com/ml-kit/vision/subject-segmentation/android).
- `com.google.android.gms:play-services-base:18.10.1` — работа с Google Play services.

Условия Google ML Kit и Google APIs применяются отдельно от лицензии собственного кода. [Официальные условия и описание обработки данных](https://developers.google.com/ml-kit/terms) указывают, что изображения и результаты обрабатываются на устройстве и не передаются ML Kit на серверы Google. SDK может обращаться за моделями и обновлениями и передаёт метрики использования и производительности. Это раскрыто в редакторе; утверждение о полном отсутствии сетевой активности SDK не делается. Загружаемая модель не включена в исходники проекта и не извлекалась из SDK.

На iOS модуль использует системные Apple Vision, Core Graphics и Image I/O. Удаление фона основано на [VNGenerateForegroundInstanceMaskRequest](https://developer.apple.com/documentation/vision/vngenerateforegroundinstancemaskrequest). Эти системные frameworks и их модели не распространяются в архиве исходников. Наличие Swift-реализации не подтверждает успешную Xcode-сборку.

Бикубическое увеличение, локальное диффузионное заполнение, обработка документов и строгая очистка PNG реализованы в проекте. Нейросетевые модели увеличения и генеративного удаления объектов в эту версию не включены. Полные ограничения описаны в [PHOTO_FEATURES.md](docs/PHOTO_FEATURES.md).

## Музыка и визуальный ориентир

Аудиозаписи Audius не включены в исходники или APK. Доступность стриминга и
скачивания проверяется по данным источника. Условия и атрибуция доступны
из раздела «О музыке»; собственные аудиофайлы импортирует пользователь.

[Glass-HQ/liquid-glass](https://github.com/Glass-HQ/liquid-glass) использован
как визуальный ориентир. Его реализация WebGPU не скопирована в нативный
клиент. Присланный пользователем `ub-mode` применяется к процессу
разработки, а не в качестве исполняемой зависимости приложения.

## Montserrat

Шрифт Montserrat (The Montserrat Project Authors), встроен в приложение. Лицензия SIL Open Font License 1.1: licenses/Montserrat-OFL-1.1.txt. Файлы шрифта взяты из npm-пакета @expo-google-fonts/montserrat 0.4.2.

## FreeLLMAPI fetch-relay Worker

`deploy/relay-worker/index.js` is copied unchanged from
https://github.com/tashfeenahmed/freellmapi (examples/fetch-relay-worker, commit 36826e7).
MIT License, Copyright (c) 2026 Tashfeen Ahmed — full text in `deploy/relay-worker/LICENSE-freellmapi`.

## expo-alternate-app-icons

https://github.com/pchalupa/expo-alternate-app-icons — MIT License. Used to switch the app icon from Settings.

## expo-camera

https://github.com/expo/expo/tree/main/packages/expo-camera — MIT License. Used only while recording a video message.
