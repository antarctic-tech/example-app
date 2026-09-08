# Мини-приложения Antarctic Wallet

У вас уже есть приложение. Этот репозиторий показывает, как встроить его в
Antarctic Wallet как **mini app**: пользователь открывает кошелёк, видит ваше
приложение внутри, входит и (если нужно) платит. Подтверждение всегда в
нативном UI кошелька, не в вашей вёрстке.

| Стек    | Пример                                             |
| ------- | -------------------------------------------------- |
| Vue     | [examples/vue](./examples/vue)         |
| React   | [examples/react](./examples/react)     |
| Angular | [examples/angular](./examples/angular) |
| Бэкенд  | [examples/backend-node](./examples/backend-node)   |

Откройте папку своего стека — там README со сценариями и запуском.
Локально без Docker: [Локальный запуск](#локальный-запуск-без-docker).
Контейнер: [Развёртывание через Dockerfile](#развёртывание-через-dockerfile).
Шаги ниже общие и не зависят от фреймворка.
Для агентов и ИИ-инструментов: [AGENTS.md](./AGENTS.md).

---

## Как это устроено

Три стороны. Их нельзя смешивать.

```
Кошелёк (AW)          Mini app (браузер)         Ваш бэкенд
────────────          ──────────────────         ──────────
iframe + UI           ваш фронт + SDK            секрет, HMAC, сессии
подтверждение         postMessage с кошельком    вызовы API AW
```

1. Кошелёк открывает ваш фронт в iframe.
2. Фронт поднимает [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk)
   и делает `init`.
3. Платежи и скоупы на стороне AW создаёт **ваш сервер**
   (`POST /api/apps/v1/intents`). Браузер секрет не видит.
4. Фронт только просит кошелёк показать лист подтверждения:
   `sdk.operations.requestConfirmation(operationId)`.

Секрет (`api_secret`) живёт только на вашем сервере. Если он оказался во
фронте — это уже не пример, а дыра.

Куда класть токены из кабинета AW:

| Что                                                               | Куда                                  |
| ----------------------------------------------------------------- | ------------------------------------- |
| `appId`                                                           | `public/config.json` → `id` мини-апки |
| `AW_API_BASE`, `AW_API_KEY`, `AW_API_SECRET`, `AW_WEBHOOK_SECRET` | `.env` **бэкенда**                    |

---

## 1. Подключить SDK

Один и тот же код на Vue, React или без фреймворка.

```ts
import { AWSDK } from "@antarctic-wallet/aw-sdk";

const sdk = new AWSDK({
  appId: "ваш-app-id",
  scopes: ["userData"], // что просите у пользователя при входе
  parentOrigin: parentOrigin, // origin кошелька, см. ниже
  persistSession: true,
});

sdk.events.on("sdk.ready", (session) => {
  // session.userContext — имя, аватар: только для экрана
  // sdk.idToken — подписанный JWT: его шлёте на СВОЙ бэкенд
});

await sdk.init();
```

`parentOrigin` нужен, чтобы `postMessage` ходил только в кошелёк:

1. `?parentOrigin=...` в URL (кошелёк так и передаёт),
2. иначе `document.referrer`,
3. иначе origin вашего dev-кошелька.

В `onUnmounted` / `beforeunload` вызовите `sdk.destroy()`.

### События

Подписывайтесь **до** `init()`. Для входа хватает первых трёх; `operation.rejected` — если есть платёж.

| Событие              | Когда                                                           |
| -------------------- | --------------------------------------------------------------- |
| `sdk.ready`          | Хендшейк прошёл. Есть сессия, `userContext`, `idToken`.         |
| `sdk.error`          | SDK сломался: плохой origin, хост недоступен, `init` не удался. |
| `session.expired`    | Сессия мертва — нужен новый `init`.                             |
| `session.refreshed`  | Токен обновился, в payload свежий `idToken`.                    |
| `scopes.granted`     | Пользователь выдал дополнительные скоупы.                       |
| `operation.rejected` | В кошельке нажали «отклонить».                                  |

```ts
sdk.events.on("sdk.ready", (session) => {
  // session.userContext — только UI; sdk.idToken — на свой бэкенд
});
sdk.events.on("sdk.error", ({ code, message }) => {
  /* показать ошибку, SDK дальше не работает */
});
sdk.events.on("session.expired", () => {
  /* сбросить UI, заново sdk.init() */
});
sdk.events.on("session.refreshed", ({ idToken }) => {
  /* если держали idToken — взять новый */
});
sdk.events.on("scopes.granted", ({ scopes }) => {
  /* пользователь выдал ещё скоупы */
});
sdk.events.on("operation.rejected", ({ operationId, reason }) => {
  /* отмена в кошельке, не путать с AWOperationError */
});

await sdk.init(); // подписки уже стоят
```

### Ошибки SDK

`init` и `requestConfirmation` бросают классы. Ловите их через `instanceof`, не только `error.message`.

| Класс              | Когда                                               |
| ------------------ | --------------------------------------------------- |
| `AWInitError`      | Не удался `init` (хендшейк, конфиг, таймаут).       |
| `AWSessionError`   | Сессия недействительна или истекла.                 |
| `AWScopeError`     | Нужный скоуп не выдан.                              |
| `AWOperationError` | Ошибка операции — есть `operationId` и `errorCode`. |
| `AWTimeoutError`   | Запрос дольше, чем `timeout` в конфиге SDK.         |

```ts
import {
  AWInitError,
  AWOperationError,
  AWTimeoutError,
} from "@antarctic-wallet/aw-sdk";

try {
  await sdk.init();
} catch (error) {
  if (error instanceof AWInitError) {
    /* показать «не удалось войти» */
  } else if (error instanceof AWTimeoutError) {
    /* сеть / кошелёк не ответил */
  } else if (error instanceof AWOperationError) {
    /* error.operationId, error.errorCode */
  } else throw error;
}
```

---

## 2. Кто пользователь

`userContext` приходит по `postMessage`. Клиент может подменить `userId` —
бэкенд этому **не верит** (IDOR).

Доверенная личность — только из подписанного `idToken`:

```ts
// фронт, после sdk.ready
await fetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ idToken: sdk.idToken }),
});
```

Ваш сервер проверяет подпись по JWKS хоста AW
(`${AW_API_BASE}/api/v2/sdk/jwks`), `iss === 'aw'`, и берёт `sub`.
Это и есть user id, на который вы заводите свою сессию.

Образец: `POST /api/auth/session` в [examples/backend-node](./examples/backend-node).

---

## 3. Платёж

Фронт **не** ходит в AW за созданием платежа. Он просит ваш сервер.

```
Mini app                    Ваш бэкенд                      AW
   │   idToken + сумма          │                             │
   │ ─────────────────────────► │  HMAC POST /api/apps/v1/    │
   │                            │  intents  { type, amount }  │
   │                            │ ──────────────────────────► │
   │         operationId        │                             │
   │ ◄───────────────────────── │                             │
   │
   │  sdk.operations.requestConfirmation(operationId)
   ▼
Кошелёк: пользователь жмёт «подтвердить» или «отклонить»
```

Типы интента:

| `type`    | Смысл                                          |
| --------- | ---------------------------------------------- |
| `pay`     | Пользователь платит вам (покупка, донат)       |
| `receive` | Вы отправляете пользователю (возврат, выплата) |
| `scopes`  | Дополнительные разрешения                      |

Мини-пример на фронте (URL `/api/intents` — это **ваш** сервер, не AW):

```ts
const res = await fetch("/api/intents", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ idToken: sdk.idToken, type: "pay", amount: "5.00" }),
});
const { operationId } = await res.json();
const result = await sdk.operations.requestConfirmation(operationId);
// result.status: confirmed | rejected | ...
```

Подпись запроса к AW считает только сервер:

```
X-Sdk-App-Signature = HMAC-SHA256(
  api_secret,
  `${timestamp}.POST./api/apps/v1/intents.${sha256(rawBody)}`
)
```

`user_id` в теле к AW берите из проверенного `idToken` (`sub`), не из
инпута и не из `userContext`. Как именно это сделать на Node — в доке
бэкенда. Свой `reference_id` заказа тоже ставьте на сервере.

После подтверждения в кошельке AW шлёт на ваш `webhook_url` события
`intent.approved` / `intent.rejected` (HMAC, секрет из кабинета). Статус
заказа закрывайте вебхуком, не ответом браузера.

Заказ (оплачен / возвращён) храните **у себя**. Кошелёк — рельса, не ваша БД.

---

## Конфиг мини-апки

`public/config.json` (имена полей те же в любом стеке):

```json
{
  "id": "ваш-app-id",
  "name": "Моя мини-апка",
  "shortDescription": "Коротко, одной строкой — для каталога",
  "description": "Полное описание на странице приложения в кошельке.",
  "icon": "./icon.svg",
  "category": "utilities",
  "requiredScopes": ["userData", "pay", "receive"]
}
```

Для хендшейка SDK нужны `id` и скоупы. `id` берётся из этого файла; скоупы SDK —
константа в файле сценария, не `requiredScopes`. Остальные поля читает каталог кошелька.

| Поле               | Обязательно | Зачем                                                                                          |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------- |
| `id`               | да          | `appId` из кабинета AW. Передаётся в `new AWSDK({ appId })`                                    |
| `name`             | для каталога | Название в UI кошелька                                                                        |
| `shortDescription` | для каталога | Одна строка в списке приложений                                                               |
| `description`      | для каталога | Длинный текст на карточке приложения                                                          |
| `icon`             | для каталога | Иконка, путь относительно `public/` (например `./icon.svg`)                                   |
| `category`         | для каталога | Слаг категории: `utilities`, `defi`, `games` и т.п.                                           |
| `requiredScopes`   | да*         | Манифест для каталога кошелька. Не передаётся в `new AWSDK({ scopes })`                       |

\*В стартерах `examples/vue` / `examples/react` / `examples/angular` скоупы заданы
константой в файле сценария. Поле `requiredScopes` всё равно держите: его читает каталог.

---

## Правила, которые нельзя нарушать

1. Секрет только в env бэкенда.
2. На бэкенде пользователь = `sub` из проверенного `idToken`.
3. Intent создаёт сервер, кошелёк только подтверждает.

Пакет SDK: [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk).

---

## Локальный запуск (без Docker)

Два процесса: бэкенд и dev-сервер фронта. Подробности стека — в README папки
примера (`vue` / `react` / `angular`).

1. Бэкенд: `examples/backend-node` → `cp .env.example .env` → указываем ключи полученные от AW → `npm start`.
   Слушает `http://127.0.0.1:3351`. `npm start` подхватывает `.env` через
   `node --env-file=.env`. Логи — в этом терминале.
2. Фронт: в папке стека `npm run dev`.
   HTTPS на `127.0.0.1` (Vue `:5184`, React `:5185`, Angular `:5186`), `/api` проксируется на бэкенд.
3. В AW, в настройках mini-app, поле **App URL**: `https://127.0.0.1:5184` (или порт своего стека).

Кошелёк **не принимает** `localhost` — в hostname должна быть точка.
Кошелёк на HTTPS, поэтому мини-апка тоже HTTPS (иначе mixed content в iframe).
Один раз откройте URL в браузере и примите самоподписанный сертификат.

---

## Развёртывание через Dockerfile

В репозитории есть один универсальный `Dockerfile`.
Он собирает **фронт выбранного стека** и кладёт его в `public` у
`examples/backend-node`, чтобы мини-апка и `/api` работали с одного origin.

Это удобно для продакшена:

1. фронт отдаётся как статика,
2. бэкенд отвечает за `idToken`, HMAC и интенты,
3. браузеру не нужны секреты,
4. кошелёк открывает один URL.

### Что важно понять

- `FRAMEWORK` выбирает, какой фронт собрать: `vue`, `react` или `angular`.
- `AW_API_BASE`, `AW_API_KEY`, `AW_API_SECRET`, `AW_WEBHOOK_SECRET` нужны **только при запуске контейнера**.
- `appId` берётся из `public/config.json` выбранного примера **во время сборки образа**.

То есть сначала вы настраиваете фронт, потом собираете образ, потом запускаете
контейнер с env-переменными бэкенда.

### Что подготовить до сборки

1. Выберите стек:
   - `examples/vue`
   - `examples/react`
   - `examples/angular`
2. Вставьте ваш `appId` в `public/config.json` выбранного стека.
3. Подготовьте значения:
   - `AW_API_BASE`
   - `AW_API_KEY`
   - `AW_API_SECRET`
   - `AW_WEBHOOK_SECRET` (для `intent.approved` / `intent.rejected`)

Пример `public/config.json`:

```json
{
  "id": "ваш-app-id",
  "name": "Моя мини-апка",
  "shortDescription": "Коротко, одной строкой — для каталога",
  "description": "Полное описание на странице приложения в кошельке.",
  "icon": "./icon.svg",
  "category": "utilities",
  "requiredScopes": ["userData", "pay", "receive"]
}
```

### Сборка образа

Сборку запускайте из корня репозитория.

#### Vue

```bash
docker build --build-arg FRAMEWORK=vue -t mini-app:vue .
```

#### React

```bash
docker build --build-arg FRAMEWORK=react -t mini-app:react .
```

#### Angular

```bash
docker build --build-arg FRAMEWORK=angular -t mini-app:angular .
```

Если не хотите запоминать дефолт в `Dockerfile`, просто **всегда передавайте
`--build-arg FRAMEWORK=...` явно**.

### Запуск контейнера

После сборки запустите контейнер и передайте env-переменные бэкенда:

```bash
docker run --rm -p 8080:8080 \
  -e AW_API_BASE=https://… \
  -e AW_API_KEY=ak_… \
  -e AW_API_SECRET=… \
  -e AW_WEBHOOK_SECRET=… \
  -e PORT=8080 \
  mini-app:vue
```

### Что будет доступно после запуска

Контейнер слушает HTTP. Для кабинета AW **не** используйте `localhost`
(hostname без точки кошелёк отбросит).

- фронт: `http://127.0.0.1:8080`
- healthcheck: `http://127.0.0.1:8080/health`
- API бэкенда:
  - `POST /api/auth/session`
  - `POST /api/intents`
  - `POST /api/webhooks` (AW → ваш сервер, не браузер)

В AW, в настройках mini-app, **App URL** для локальной проверки: `http://127.0.0.1:8080`.
Если кошелёк открыт по HTTPS, iframe не загрузит HTTP (mixed content) —
поставьте TLS перед контейнером (Caddy / nginx / mkcert) и укажите
`https://127.0.0.1:…` или ваш домен. В проде — обычный HTTPS-домен,
не loopback.

Логи бэкенда: `docker logs` того контейнера (`[boot]`, `[auth]`, `[intents]`).

### Как проверить, что всё поднялось

1. Откройте `http://127.0.0.1:8080`.
2. Убедитесь, что загрузилась стартовая страница примеров.
3. Откройте `http://127.0.0.1:8080/health`:

```json
{ "ok": true }
```

4. Проверьте логи контейнера: сервер должен слушать `0.0.0.0:8080`.

### Типичные ошибки

#### 1. Открывается фронт, но платежи не работают

Скорее всего не переданы:

- `AW_API_BASE`
- `AW_API_KEY`
- `AW_API_SECRET`

#### 2. Кошелёк не открывает мини-апку

В **App URL** стоит `localhost` (нет точки в hostname) или HTTP при HTTPS-кошельке.
Для контейнера без TLS используйте хотя бы `http://127.0.0.1:8080`; для iframe
в HTTPS-кошельке нужен TLS перед контейнером.

#### 3. Собрался не тот фронт

Значит при сборке не был передан `--build-arg FRAMEWORK=...`.
Пересоберите образ явно:

```bash
docker build --build-arg FRAMEWORK=react -t mini-app:react .
```

#### 4. В контейнере нет вашего `appId`

`appId` читается из `public/config.json` **во время сборки**.
Если вы поменяли `config.json`, нужно **пересобрать образ**, а не только
перезапустить контейнер.
