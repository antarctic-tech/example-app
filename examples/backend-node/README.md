# Бэкенд мини-апки (Node.js)

Это **ваш** сервер, не API Antarctic Wallet (AW).

Кошелёк даёт три вещи: SDK в iframe, ключи чтобы проверить JWT пользователя
и API для платежей с вашего сервера. Всё остальное (заказы, каталог, сессии) —
ваша зона. Файл [`server.mjs`](./server.mjs) — образец. Скопируйте его, не
выдумывайте роуты платформы вроде `/api/donate`.

```
Кошелёк (AW)                 Мини-апка (браузер)              Этот сервер
iframe + нативное подтверждение   фронт + aw-sdk              секреты, сессии
                              fetch('/api/...')  ──────────►  проверка JWT
                                                              Bearer POST в AW
```

Нужен Node 20+.

---

## Быстрый старт

```bash
cp .env.example .env
# заполните AW_API_BASE / AW_APP_ID / AW_API_SECRET
npm install
npm start
```

`npm start` = `node --env-file=.env server.mjs`.
Код `.env` не парсит: его подхватывает Node. В Docker файл не кладут в образ —
переменные передают через `-e`.

Проверка: [http://127.0.0.1:3351/health](http://127.0.0.1:3351/health) → `{"ok":true}`.

Логи — в этом терминале: `[boot]`, `[auth]`, `[intents]`, `[webhook]`.
Перезагрузка при правках: `npm run dev`.

Фронт (`vue` :5184, `react` :5185, `angular` :5186)
проксирует `/api` сюда. В AW, в настройках mini-app, **App URL** — адрес **фронта**
(`https://127.0.0.1:5184`), не этот порт.

Если в логе есть `(static from .../public)` — Express ещё отдаёт собранную
мини-апку из папки `public/` (так делает Docker). Для локальной разработки
это не нужно: UI смотрите на Vite/ng, сюда ходят только `/api` и `/health`.

---

## Куда класть секреты

Только в `.env` (локально) или в env процесса (Docker, оркестратор).
Никогда во фронт и никогда в тело запроса из браузера.

```
# Origin API без суффикса /api
AW_API_BASE=https://api.example.com
AW_APP_ID=ваш-app-id
AW_API_SECRET=…
PORT=3351
```

| Переменная          | Зачем                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `AW_API_BASE`       | Origin API AW, **без** `/api` на конце                                |
| `AW_APP_ID`         | `appId` из кабинета, заголовок `X-Aw-App-Id` (тот же, что в `config.json`) |
| `AW_API_SECRET`     | Секрет приложения: и для запросов в AW, и для проверки вебхуков. Во фронт не класть — иначе любой сможет создавать платежи от вашего имени |
| `PORT`              | Порт этого сервера. По умолчанию в примере `3351`                     |

Плохо: `https://api.example.com/api` — интент уйдёт на `/api/api/apps/v1/intents`.
Хорошо: `https://api.example.com`.

---

## Что умеет этот сервер

Три ручки. Браузер ходит только в первые две. Третья — это AW, который
пишет вам сам, когда платёж завершился.

### `GET /health`

Живой ли процесс. Ответ: `{"ok": true}`. Откройте в браузере, если не уверены,
что сервер поднялся.

### `POST /api/auth/session` — кто этот пользователь

После входа SDK даёт фронту `idToken` — подписанный JWT кошелька.
Фронт присылает его сюда. Сервер проверяет подпись по ключам AW
(`${AW_API_BASE}/api/v2/sdk/jwks`), что токен выпущен AW (`iss === 'aw'`)
и предназначен вашему приложению (`aud === appId`).

Внутри токена поле `sub` — **id пользователя в вашем приложении**. Это
случайная hex-строка (`user_app_login`), а не номер аккаунта в AW.
Один и тот же человек в другом мини-приложении получит другой `sub`.
Если пользователь отзовёт доступ и зайдёт снова — `sub` будет новый.

Этот `sub` и есть ключ вашей сессии / записи в БД.

Запрос: `{ "idToken": "<sdk.idToken>" }`  
Ответ:

```json
{
  "ok": true,
  "userId": "a1b2c3d4e5f60718",
  "userAppLogin": "a1b2c3d4e5f60718",
  "hasKyc": true,
  "hasKycData": true,
  "kycCountry": "RU",
  "expiresAt": 1710000000
}
```

`userId` и `userAppLogin` — одно и то же (`sub`). `hasKyc` / `hasKycData` /
`kycCountry` приходят, только если приложение просило scope `userData`.
Телефон, email и глобальный id AW в токене нет.

Имя и аватар из SDK (`userContext`) на бэкенд **нельзя** класть в авторизацию:
это сообщение из iframe, клиент может подставить чужие поля.

### `POST /api/intents` — создать платёж или возврат

Фронт не ходит в AW сам. Он говорит вашему серверу: «создай операцию».
Сервер ещё раз проверяет JWT, берёт `sub` и уже **с секретом** зовёт AW.

| `type`    | Смысл                         | Что передать           | Что дальше |
| --------- | ----------------------------- | ---------------------- | ---------- |
| `pay`     | Пользователь платит вам       | `amount`               | Фронт зовёт `requestConfirmation` — лист в кошельке |
| `receive` | Вы платите пользователю       | `amount`               | Деньги уходят сразу, листа нет. В ответе уже `approved` или `failed` |
| `scopes`  | Допросить ещё разрешения      | `scopes`: `["pay"]`    | Как у `pay`: лист в кошельке |

Запрос от фронта (секретов здесь нет):

```json
{ "idToken": "<sdk.idToken>", "type": "pay", "amount": "5.00" }
```

Ответ для `pay`: `{ "operationId": "…", "status": "pending" }`.  
Для `receive`: `{ "operationId": "…", "status": "approved" }` или `failed`
(тогда ещё `failureReason`).

Что клиент прислал как `user_id` / `user_app_login` / `apiSecret` — игнорируйте.
В AW уходит только `user_app_login` из проверенного токена. Если послать
старое поле `user_id`, AW ответит `422 USER_ID_NOT_ACCEPTED`.

`reference_id` — id заказа **у вас**. Ставьте его на сервере, не из браузера.
Для `receive` он обязателен: без него повтор запроса (таймаут, ретрай) может
перевести деньги второй раз. Тот же id и те же данные → AW вернёт старый
интент. Тот же id, но другая сумма → `409 REFERENCE_ID_CONFLICT`.

### `POST /api/webhooks` — AW сообщает итог

Это не браузер. Когда пользователь подтвердил или отклонил операцию
(или `receive` уже исполнился), AW стучится на URL, который вы указали
в кабинете (`webhook_url`).

Проверьте подпись тем же `AW_API_SECRET`, что и Bearer-запросы.
Заголовки: `X-Sdk-Webhook-Timestamp`, `X-Sdk-Webhook-Signature`.
Подпись: HMAC-SHA256 секрета по строке `"{timestamp}.{sha256(сырое тело)}"`.
Считайте по **сырым байтам**, не по `JSON.parse` — иначе подпись разъедется.
Если часы сервера и AW расходятся больше чем на 5 минут — отклоните.

События:

| Событие | Когда |
| ------- | ----- |
| `intent.approved` / `intent.rejected` | Пользователь нажал в кошельке |
| `payment.succeeded` / `payment.failed` | Автоматический `receive` |

В теле — `user_app_login` (тот же `sub`), не глобальный id.
В проде заказ помечайте **здесь** и не обрабатывайте одно и то же
`operation_id` + `event` дважды. Ответ фронта после `requestConfirmation`
для учёта денег не годится: вкладку можно закрыть.

---

## Как фронт это вызывает

После `sdk.init()`:

```ts
await fetch('/api/auth/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ idToken: sdk.idToken }),
});

const { operationId } = await fetch('/api/intents', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ idToken: sdk.idToken, type: 'pay', amount: '5.00' }),
}).then((r) => r.json());

await sdk.operations.requestConfirmation(operationId);
```

`/api` на dev-сервере фронта проксируется на этот бэкенд. Секреты в этих
запросах не участвуют.

---

## Этот сервер → AW

```
POST ${AW_API_BASE}/api/apps/v1/intents

X-Aw-App-Id:     AW_APP_ID
Authorization:   Bearer AW_API_SECRET
```

Тело (пример `pay`):

```json
{ "type": "pay", "user_app_login": "a1b2c3d4e5f60718", "data": { "amount": "5.00" } }
```

`user_app_login` — это `sub` из JWT, строка. Числовой `user_id` слать нельзя.
`operationId` в ответе AW бывает в `data.operationId` или `data.operation_id` —
пример понимает оба. Рядом лежит `status`: `pending`, `approved` или `failed`.

Деньги при `pay` идут с баланса пользователя на баланс вашего приложения
в AW (того, чей `appId` и секрет в запросе). `receive` — наоборот, сразу,
без экрана «подтвердить».

---

## Правила, которые нельзя нарушать

1. Секрет (`AW_API_SECRET`) только на сервере, никогда во фронте.
2. Пользователь — `sub` из проверенного `idToken`. Имя и аватар из SDK не считаются доказательством.
3. В AW уходит поле `user_app_login` (= `sub`), не `user_id`.
4. `pay` подтверждает человек в кошельке. `receive` уже выполнен в ответе сервера.
5. В проде заказ закрывайте вебхуком, не тем, что ответил браузер.

Готовый код: [`server.mjs`](./server.mjs).
