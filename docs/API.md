# Линия 0.5.1 — контракт API

Node.js 24, Fastify, SQLite schema version 5. Пути относительны адресу API; production использует HTTPS. Авторизация HTTP: `Authorization: Bearer <token>`. Не передавайте токен в URL. Ошибки: `{error,code?,...details}` с соответствующим HTTP-статусом.

## Аккаунт и два слова

Ник: `[a-z0-9_]`, 3–24 символа, lowercase. Новый пароль: 15–128 Unicode code points после NFC, без управляющих символов. Слова: 4–64 русские/английские буквы, trim + NFC + lowercase; отличаются друг от друга, ника и пароля. `confirmationWord` нужен при обычном входе, `recoveryWord` — при восстановлении. Это два секрета знания, не независимые факторы. Сервер хранит отдельные salted scrypt-хеши.

Парный ручной ввод — поведение UI. API получает одно итоговое значение каждого поля и не может доказать, как набран текст. Клиент не проверяет существование ника на сервере между первым и вторым шагами входа.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /health` | — | `{status:"ok"}` |
| `POST /auth/register` | `{username,password,displayName,confirmationWord,recoveryWord,deviceName?}` | 201 `{token,user,securitySetupRequired}` |
| `POST /auth/login` | `{username,password,confirmationWord,deviceName?}` | `{token,user,securitySetupRequired}` |
| `POST /auth/logout` | авторизация | `{ok:true}`; отзыв текущей сессии и WS |
| `GET /me` | авторизация | `{user,securitySetupRequired}` |
| `GET /auth/security` | авторизация | `{confirmationConfigured,recoveryConfigured}` |
| `POST /auth/password` | `{currentPassword,currentConfirmationWord,newPassword}` | `{ok:true}`; все сеансы завершены |
| `POST /auth/confirmation-word` | `{currentPassword,currentConfirmationWord,confirmationWord}` | `{ok:true}`; все сеансы завершены |
| `POST /auth/recovery-word` | `{currentPassword,currentConfirmationWord,recoveryWord}` | `{ok:true}`; все сеансы завершены |
| `GET /auth/sessions` | авторизация | `{sessions:[{id,deviceName,createdAt,lastActiveAt,expiresAt,isCurrent}]}` |
| `POST /auth/sessions/revoke` | `{sessionId}` | `{ok:true}` |
| `POST /auth/sessions/revoke-others` | `{}` | `{ok:true}` |

Неверные ник, пароль и подтверждение дают общую ошибку входа. Регистрация сообщает о занятом нике: отсутствие проверки на первом экране не означает полной защиты от перечисления публичных аккаунтов. Legacy-аккаунты без настроенных слов входят со старым паролем и пустым подтверждением; `securitySetupRequired` открывает настройки безопасности. Новые аккаунты такого исключения не имеют.

## Восстановление

| Метод и путь | Запрос | Ответ / действие |
|---|---|---|
| `POST /auth/recovery/verify` | `{username,recoveryWord,deviceName?}` | `{resetToken,requestId,readyAt,expiresAt,serverTime}` |
| `POST /auth/recovery/status` | `{resetToken}` | `{requestId,readyAt,expiresAt,serverTime,status}`; status waiting/ready |
| `POST /auth/recovery/reset` | `{resetToken,newPassword}` | `{ok:true}` |
| `GET /auth/recovery/requests` | авторизация старой сессии | `{requests:[{id,createdAt,readyAt,expiresAt,deviceName}]}` |
| `POST /auth/recovery/cancel` | авторизация + `{requestId}` | `{ok:true}` |

После правильного слова сервер создаёт purpose-bound 256-bit grant, хранит его хеш и ждёт **10 минут**. Затем grant действует ещё **20 минут**. Часы клиента не сокращают ожидание. Новый успешный запрос заменяет прежний; отмена, истечение срока, изменение учётных данных и успешный reset делают grant недействительным.

Три неверных восстановления одного ника блокируют только восстановление на **24 часа** после третьей ошибки. Счётчик долговечен и защищён от параллельных запросов; частичный бюджет истекает после 24 часов неактивности. Неизвестный ник даёт тот же тип ошибки. IP rate limit и ограничитель входа независимы. Ошибки содержат `attemptsRemaining`, `retryAfterSeconds` или временные метки в зависимости от `code`.

Успешный reset меняет **только пароль**, сохраняет оба слова, отзывает все сеансы/WS и увеличивает credential version. Действующие сеансы клиентов 0.3.0 получают WS-событие и перечитывают долговечный список запросов. APNS/FCM для закрытого приложения не подключены. Восстановление аккаунта не восстанавливает потерянные ключи переписки.

## Профили и чаты

`User`: `{id,username,displayName,bio,avatarColor,avatarId,createdAt}`. Account/chat/device IDs — UUID, даты — ISO UTC.

| Метод и путь | Назначение |
|---|---|
| `PATCH /me` | `{displayName?,bio?,avatarColor?,avatarId?}` → `{user}`. Имя ≤50, bio ≤160, цвет #RRGGBB; аватар — собственное изображение ≤4 MiB или null |
| `GET /users?q=...` | `{users}`; от 2 символов, до 30 результатов без себя |
| `GET /chats` | `{chats}`; последние разговоры сверху |
| `POST /chats` | `{userId}` → `{chat}`; один личный чат на пару, повтор идемпотентен |
| `GET /chats/:id/messages?before=&limit=50` | `{messages,hasMore}`; окно по возрастанию id, before эксклюзивен, limit 1–100 |
| `POST /chats/:id/read` | `{messageId}` → `{ok:true,lastReadMessageId}`; сообщение этого чата, счётчик не убывает |
| `POST /uploads` | multipart file → 201 `{attachment}`; production принимает только аватар, проверенное изображение ≤4 MiB |
| `GET /files/:id` | авторизация и ACL; публичность аватаров и доступ к encrypted blobs различаются |

`Chat`: `{id,peer,lastMessage,unreadCount,lastReadMessageId,peerLastReadMessageId,createdAt,updatedAt}`.

`Message`: `{id,chatId,senderId,clientId,text,attachment,createdAt,encrypted?,legacy?}`. Для новых сетевых сообщений text пуст, attachment=null; содержимое находится в encrypted. Расшифрованные поля клиент добавляет только локально после проверки.

## Устройства шифрования

Native libsignal **0.106.0**. Сервер получает только публичные ключи. Клиент требует явного подтверждения нового устройства после сравнения кода безопасности по доверенному каналу; выдача bundle сервером не создаёт доверие.

```ts
type PublicBundle = {
  registrationId: number; // 1..16383
  identityKey: string;    // base64, 33 bytes serialized EC public key
  signedPreKey: {id:number; publicKey:string; signature:string};
  kyberPreKey: {id:number; publicKey:string; signature:string};
  preKeys: {id:number; publicKey:string}[];
};
// ClaimedBundle: optional preKey (singular) вместо preKeys.
```

| Метод и путь | Контракт |
|---|---|
| `POST /e2ee/devices` | `{deviceId,deviceName,...bundle}` → `{device,preKeyCount}`; привязка к текущей auth session |
| `GET /e2ee/devices/self` | свои активные/отозванные devices и остаток prekeys |
| `GET /e2ee/devices?userId=...` | активные устройства себя либо существующего собеседника |
| `POST /e2ee/prekeys/claim` | `{userId,deviceId}` → `{device,bundle}`; атомарное потребление EC prekey, если есть |
| `POST /e2ee/devices/revoke` | `{deviceId}` → `{ok:true}`; отзыв bound auth session, её устройств и WS |

`Device`: `{id,userId,deviceName,identityKey,registrationId,createdAt,active}`. До 5 активных устройств/аккаунт, 100 unused prekeys/устройство, до 32 ключей/публикацию. ID потреблённых prekeys остаются tombstones; повтор не возвращает их в выдачу. Device ID не меняет владельца, identity или registrationId. Новый вход с прежним локальным vault может реактивировать прежнюю идентичность через новую auth session.

## Ciphertext relay

`POST /chats/:chatId/messages`:

```json
{
  "clientId": "<UUID>",
  "encrypted": {
    "scheme": "signal-v1",
    "senderDeviceId": "<UUID>",
    "envelopes": [
      {"userId":"<UUID>","deviceId":"<UUID>","type":3,"body":"<base64>"}
    ],
    "attachmentIds": []
  }
}
```

Клиент генерирует UUID для clientId; сервер принимает строку длиной 8–100 символов. Ciphertext type — 2 или 3. Нужен точный набор активных устройств собеседника и других своих устройств, кроме отправителя. До 10 envelopes, до 64 KiB decoded ciphertext каждый. Изменение набора даёт 409 `E2EE_DEVICES_CHANGED`. Точный повтор принятого clientId/ciphertext возвращает прежнее сообщение; изменённый ciphertext с тем же ID отвергается.

Клиент атомарно сохраняет ratchet state, ciphertext outbox и локальную историю до HTTP-отправки. Внутри encrypted payload проверяются version, chatId/clientId, sender/recipient account и device IDs, текст, timestamp и attachmentIds. Неуспешная проверка не сохраняет изменённое состояние или cursor.

`GET /e2ee/inbox?deviceId=<id>&chatId=<id>&after=0&limit=100` → `{messages,nextCursor,hasMore}`, от старых к новым после after. Требуется current active session-bound device и участие в чате. Клиент хранит курсор каждого чата. Последние 50 строк истории не заменяют последовательную обработку inbox.

Старые plaintext-строки не шифруются задним числом. Production API скрывает их text/attachment, выставляет legacy=true и отклоняет новые plaintext-сообщения. Режим `allowLegacyPlaintext` удалён полностью. Новые сообщения принимаются только в encrypted-форме; legacy chat-файлы также недоступны через `/files/:id`, если они отдельно не опубликованы как аватар.

## Зашифрованные вложения

Клиент: AES-256-GCM-SIV через official libsignal, 32-byte key +12-byte nonce из async системного CSPRNG. Имя, MIME, ключ, nonce и UUID привязки находятся внутри Signal payload. Сервер получает encrypted blob.

`POST /e2ee/files`: multipart file, application/octet-stream, без исходного имени → 201 **`{id,size}`**. Серверный лимит: 20 MiB +64 bytes, клиентский plaintext ≤20 MiB. До привязки через attachmentIds blob доступен владельцу, после — участникам чата. `GET /files/:id` выдаёт octet-stream с фиксированным именем. Получатель обязан проверить AEAD перед открытием файла.

## WebSocket

`/ws`; первое сообщение `{type:"auth",token}` в течение 5 секунд → `{type:"ready",userId}`. Серверные события: message, chat, read, typing, profile, recovery.requested, recovery.updated, e2ee.devices, error. Message несёт ciphertext, recovery event не содержит resetToken. Клиент отправляет typing для своего чата и ping. Отзыв сессии закрывает WS; reconnect перечитывает долговечные данные.

HTTP Origin разрешён только явным ALLOWED_ORIGINS. Для WS дополнительно допускается канонический Origin того же Host/port для совместимости Android; это не отменяет auth и не расширяет HTTP CORS. Proxy сохраняет внешний Host; TRUSTED_PROXIES ограничивается его настоящим адресом.

## Границы

Нет групп, каналов, звонков, закрытых push, переноса истории на новое устройство или браузерной E2EE. Сервер видит метаданные доставки и публичные профили. Ключи и локальная история находятся в SQLCipher, случайный ключ которого сохранён в SecureStore и не выводится из пароля/слов. Фактические проверки и ограничения описаны в TEST_REPORT, AUTH_TEST_REPORT, E2EE_TEST_REPORT и NATIVE_TEST_REPORT.


## Username, Platina и статус 0.5

Публичный `username` уникален; `login_name` фиксируется при регистрации и не меняется вместе с публичным именем. Вход и восстановление используют первоначальный логин. UUID аккаунта и ключи E2EE не зависят от публичного имени. `/users?q=@name` ищет именно публичный ник, обычный запрос также учитывает отображаемое имя.

| Метод и путь | Запрос | Ответ |
| --- | --- | --- |
| `GET /me/username` | — | `{accountId,loginName,username,freeChangeAvailable,canChangeUsername,platina,canSetStatusEmoji,statusEmoji,statusEmojiChoices}` |
| `PATCH /me/username` | `{username}` | `{user,status}` |
| `PATCH /me/status-emoji` | `{statusEmoji:string|null}` | `{user,status}` |

Одна фактическая смена после регистрации бесплатна. Повтор без изменения не расходует её. Последующие смены и выбор статуса требуют действующей Platina, проверяемой сервером. Истёкшее/отозванное право не принимается по клиентскому флагу. Публичный `User` не содержит приватного логина или entitlement-записи. Оплата не подключена; административный CLI не является пользовательским маршрутом покупки.

В 0.5.1 активная бессрочная выдача возвращает `platina: { active: true, expiresAt: null, permanent: true }`. Для конечных выдач и отсутствия права прежняя форма сохраняется. Само по себе `expiresAt: null` не означает активную Platina. При отзыве бессрочной выдачи `active` становится `false`.

У видимого эмодзи публичные поля — `statusEmoji` и `statusEmojiExpiresAt`; только при активной бессрочной выдаче дополнительно появляется `statusEmojiPermanent: true`, а срок равен `null`. При отзыве эмодзи скрывается, публичный permanent-признак отсутствует. Административные команды не отправляют WS-обновление: клиент получает новое состояние при следующем чтении профиля. Полный контракт, UUID-привязка и миграция — [PLATINA_OWNER_0.5.1.md](PLATINA_OWNER_0.5.1.md).

## AI 0.5: отдельная явно разрешённая внешняя обработка

`GET /ai/status` возвращает доступность, возможности и лимиты. `POST /ai/chat` требует действующей сессии, `consent:true` и `messages` только с ролями user/assistant. Реализованы текст и код; изображения/видео/3D/внешние действия выключены. Ответы провайдера, содержащие tool calls, не исполняются.

API не принимает пользовательские URL, модели, system prompts или ключи провайдера. Сервер использует закреплённый OpenRouter free router с нулевыми пределами цены. `OPENROUTER_API_KEY` задаётся только на сервере; без ключа возвращается явное состояние недоступности. Клиентская AI-история хранится в памяти и передаётся только по согласию; это не E2EE-разговор между людьми. См. `AI_BACKEND_REPORT.md` и `E2EE_ONLY_0.5.md`.

## Медиа внутри E2EE 0.5

У attachment допускаются проверяемые `media` (размеры/длительность/HDR) и `preview` (очищенный JPEG не более 8 КиБ, стороны до 256). Они находятся внутри Signal payload вместе с ключом файла; relay их не расшифровывает. Фото и видео проходят локальную очистку до шифрования; ошибка подготовки блокирует отправку исходника. HTTP-контракт файлов не раскрывает исходное имя/MIME/ключ. Форматы и ограничения — `MEDIA_0.5_REPORT.md`.
