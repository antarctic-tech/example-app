# Бэкенд мини-апки (Node.js)

Это **ваш** сервер, не API Antarctic Wallet (AW).

Кошелёк даёт три вещи: SDK в iframe, JWKS для проверки `idToken` и B2B-ручку
интентов. Всё остальное (заказы, каталог, сессии) — ваша зона.
Файл [`server.mjs`](./server.mjs) — образец. Скопируйте его, не выдумывайте
роуты платформы вроде `/api/donate`.

```
Кошелёк (AW)                 Мини-апка (браузер)              Этот сервер
iframe + нативное подтверждение   фронт + aw-sdk              секреты, HMAC, сессии
                              fetch('/api/...')  ──────────►  проверка JWT
                                                              HMAC POST в AW
```

Нужен Node 20+.

---

## Быстрый старт

```bash
cp .env.example .env
# заполните AW_API_BASE / AW_API_KEY / AW_API_SECRET
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
AW_API_KEY=ak_…
AW_API_SECRET=…
AW_WEBHOOK_SECRET=…
PORT=3351
```

| Переменная          | Зачем                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `AW_API_BASE`       | Origin API AW, **без** `/api` на конце                                |
| `AW_API_KEY`        | Публичный ключ приложения (`ak_…`), заголовок `X-Sdk-App-Key`         |
| `AW_API_SECRET`     | Секрет HMAC. Если он во фронте — любой может создавать платежи от вас |
| `AW_WEBHOOK_SECRET` | Проверка входящих вебхуков `intent.approved` / `intent.rejected`      |
| `PORT`              | Порт этого сервера. По умолчанию в примере `3351`                     |

Плохо: `https://api.example.com/api` — интент уйдёт на `/api/api/apps/v1/intents`.
Хорошо: `https://api.example.com`.

---

## Что умеет этот сервер

Три ручки. Браузер ходит только в первые две.

### `GET /health`

Живой ли процесс. Ответ: `{"ok": true}`.

### `POST /api/auth/session`

Фронт после `sdk.ready` присылает JWT кошелька. Сервер проверяет подпись
по JWKS (`${AW_API_BASE}/api/v2/sdk/jwks`), `iss === 'aw'`, и берёт `sub`.

Запрос: `{ "idToken": "<sdk.idToken>" }`  
Ответ: `{ "ok": true, "userId": "<sub>", "tgId": <число|null>, "expiresAt": <exp> }`

`userId` — ключ вашей сессии. `tgId` из клейма `tg_id` опционален.

`userContext` из SDK (имя, аватар, `userId` на экране) **нельзя** использовать
для авторизации: это `postMessage`, клиент может подменить поля (IDOR).

### `POST /api/intents`

Фронт присылает токен и параметры операции. Сервер снова проверяет JWT,
берёт `user_id` из `sub` (положительное целое), подписывает HMAC и
создаёт интент в AW. Браузеру возвращает только `operationId`.

Дальше фронт вызывает `sdk.operations.requestConfirmation(operationId)` —
лист подтверждения рисует кошелёк, не вы.

Запрос:

```json
{ "idToken": "<sdk.idToken>", "type": "pay", "amount": "5.00" }
```

| `type`    | Когда                         | Что ещё нужно          |
| --------- | ----------------------------- | ---------------------- |
| `pay`     | Пользователь платит вам       | `amount`               |
| `receive` | Вы платите пользователю       | `amount`               |
| `scopes`  | Дополнительные разрешения     | `scopes`: `["pay"]`    |

Поля `apiKey`, `apiSecret`, `user_id`, `telegramUserId` из клиента
игнорируются. `user_id` в AW всегда из токена.

`reference_id` — id вашего заказа. В этом примере его нет: в проде ставьте
со своей строки в БД, не из браузера. Повтор того же id → `409 REFERENCE_ID_CONFLICT`.

### `POST /api/webhooks`

Это не браузер. После approve/reject AW шлёт сюда подписанное событие.
`webhook_url` задаётся на SdkApp в кабинете.

Заголовки: `X-Sdk-Webhook-Timestamp`, `X-Sdk-Webhook-Signature`.  
Подпись: `hex(HMAC-SHA256(webhook_secret, "{ts}.{sha256(сырое тело)}"))`.
Дрейф часов > 5 мин — отклонить. Считать HMAC по **сырому** body,
не по `JSON.parse`.

События: `intent.approved` (для pay/receive — после перевода), `intent.rejected`.
В проде помечайте заказ здесь и дедупьте по `data.operation_id` + `event`.
Ответ браузера после `requestConfirmation` — не источник истины.

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

## HMAC: этот сервер → AW

```
POST ${AW_API_BASE}/api/apps/v1/intents

X-Sdk-App-Key:       AW_API_KEY
X-Sdk-App-Timestamp: unix-секунды
X-Sdk-App-Signature: hex(HMAC-SHA256(secret, "{ts}.POST./api/apps/v1/intents.{sha256(body)}"))
```

Тело (пример `pay`):

```json
{ "type": "pay", "user_id": 4242, "data": { "amount": "5.00" } }
```

`user_id` — числовой `sub` из JWT. Дрейф > 5 мин → `401 STALE_REQUEST`.
`operationId` в ответе AW может лежать в `data.operationId` или
`data.operation_id` — пример нормализует оба.

Куда уходят деньги при `pay`: с баланса пользователя на баланс **вашего
SdkApp** в AW (тот, чьим ключом подписан запрос). `receive` — обратно.

---

## Правила, которые нельзя нарушать

1. Секрет только на сервере.
2. Пользователь = `sub` из проверенного `idToken`, не `userContext`.
3. Интент создаёт сервер. Фронт только показывает лист в кошельке.
4. Статус заказа в проде закрывайте вебхуком, не ответом из браузера.

Готовый код: [`server.mjs`](./server.mjs).
