# Мини-приложение Antarctic Wallet — Angular

Документация на русском. English: [общий README](../../README.md) · [SDK](https://github.com/antarctic-tech/aw-sdk).

Angular 19 + [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk).

Один проект, три сценария. Вставьте свой `appId`, запустите — и увидите, как работает
вход, платёж и возврат внутри кошелька.

## Сценарии

| Сценарий              | Что делает                                               | Файл                                                                                       | Скоупы                       |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| **Вход**              | Авторизация пользователя, получение доверенного `userId` | [`src/app/scenarios/auth.component.ts`](./src/app/scenarios/auth.component.ts)             | `userData`                   |
| **Донат**             | Вход + односторонний платёж (без возврата)               | [`src/app/scenarios/pay.component.ts`](./src/app/scenarios/pay.component.ts)               | `userData`, `pay`            |
| **Покупка и возврат** | Вход + покупка + возврат                                 | [`src/app/scenarios/pay-refund.component.ts`](./src/app/scenarios/pay-refund.component.ts) | `userData`, `pay`            |

Стартовая страница (`#/`) — каталог примеров. **В свой продукт копируйте один файл
из `src/app/scenarios/`**, а не всё приложение.

---

## Быстрый старт

Два процесса: бэкенд и `ng serve`. В настройках mini-app в AW поле **App URL** —
не `localhost` (кошелёк требует точку в hostname) и **HTTPS**, потому что
кошелёк сам на HTTPS.

Укажите в AW в настройках своего mini-app App URL `https://127.0.0.1:5186`

### 1. Бэкенд

```bash
cd ../backend-node
cp .env.example .env
npm install
npm start            # http://127.0.0.1:3351
```

В `.env`:

```
AW_API_BASE=https://api.example.com
AW_APP_ID=ваш-app-id
AW_API_SECRET=…
PORT=3351
```

`npm start` подхватывает `.env` (`node --env-file=.env`). Логи — в этом терминале (`[boot]`, `[auth]`, `[intents]`).

Проверка: `http://127.0.0.1:3351/health` → `{"ok":true}`.

### 2. Фронтенд

```bash
npm install
npm run dev          # https://127.0.0.1:5186
```

Dev-сервер слушает `127.0.0.1` с самоподписанным TLS и проксирует `/api` на бэкенд
(`proxy.conf.json`). Один раз откройте `https://127.0.0.1:5186` в браузере и
примите сертификат — иначе iframe кошелька не загрузится.

### 3. Конфиг

В `public/config.json` вставьте `appId` из кабинета Antarctic Wallet.
Для SDK нужны `id` и скоупы; остальные поля читает каталог кошелька.

```json
{
  "id": "ваш-app-id",
  "name": "Моя мини-апка",
  "shortDescription": "Коротко, одной строкой — для каталога",
  "description": "Полное описание на странице приложения в кошельке.",
  "icon": "./icon.svg",
  "category": "utilities",
  "requiredScopes": ["userData", "pay"]
}
```

| Поле               | Зачем                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `id`               | `appId` из кабинета. `new AWSDK({ appId })`                                                |
| `name`             | Название в UI кошелька                                                                     |
| `shortDescription` | Одна строка в списке приложений                                                            |
| `description`      | Длинный текст на карточке приложения                                                       |
| `icon`             | Иконка, путь относительно `public/`                                                        |
| `category`         | Слаг категории: `utilities`, `defi`, `games`                                               |
| `requiredScopes`   | Манифест для каталога. В этом примере скоупы `init` заданы константой в файле сценария     |

| Что положить | Куда                               |
| ------------ | ---------------------------------- |
| `appId`      | `public/config.json` → `id` и `AW_APP_ID` в `.env` бэкенда |
| Секрет API   | `.env` бэкенда (никогда в браузер) |

Dev-сервер проксирует `/api` → бэкенд (`proxy.conf.json`). Секреты живут **только** на сервере.

---

## Как это работает

```
Кошелёк (AW)              Мини-апка (браузер)           Ваш бэкенд
────────────              ──────────────────           ──────────
iframe + нативный UI      ваш фронт + SDK             секрет, сессии
подтверждает операции     postMessage ↔ кошелёк       проверяет idToken
                          просит ваш сервер           создаёт интент в AW
```

1. Кошелёк открывает ваш фронт в iframe.
2. Пользователь нажимает «Войти» → SDK делает хендшейк с кошельком.
3. Фронт получает `idToken` и шлёт его на **ваш** сервер для проверки.
4. Для платежа: фронт просит **ваш** сервер создать интент → сервер создаёт интент в AW → фронт показывает лист подтверждения в кошельке.

---

## 1. Подключение SDK

Подписки на события **до** `init()`. В `ngOnDestroy` — `sdk.destroy()`.

### Фронт

```ts
import { Component, OnDestroy, OnInit } from "@angular/core";
import { AWSDK, AWScope, AWInitError, AWTimeoutError } from "@antarctic-wallet/aw-sdk";

const SCOPES = [AWScope.USER_DATA]; // в каждом сценарии свой набор

@Component({
  /* ... */
})
export class AuthComponent implements OnInit, OnDestroy {
  sdk: AWSDK | null = null;

  async ngOnInit() {
    const config = await fetch("./config.json").then((r) => r.json());
    const instance = new AWSDK({
      appId: config.id,
      scopes: [...SCOPES],
      parentOrigin: getParentOrigin(),
      persistSession: true,
    });
    this.sdk = instance;

    instance.events.on("sdk.ready", (session) => {
      // session.userContext — имя, аватар (только для UI)
      // instance.idToken — подписанный JWT → шлём на свой бэкенд
    });
    instance.events.on("sdk.error", ({ message }) => {
      /* SDK сломался */
    });
    instance.events.on("session.expired", () => {
      /* нужен новый init() */
    });
  }

  async login() {
    try {
      await this.sdk?.init();
    } catch (error) {
      if (error instanceof AWInitError) {
        /* не удалось войти */
      }
      if (error instanceof AWTimeoutError) {
        /* таймаут */
      }
    }
  }

  ngOnDestroy() {
    this.sdk?.destroy();
    this.sdk = null;
  }
}
```

### `parentOrigin`

Кошелёк передаёт `?parentOrigin=...` в URL. SDK использует его для `postMessage`:

```ts
function getParentOrigin(): string {
  const fromQuery = new URLSearchParams(window.location.search).get(
    "parentOrigin",
  );
  if (fromQuery) return fromQuery;
  if (window.parent !== window && document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {}
  }
  return "https://localhost:3310";
}
```

### События SDK

| Событие              | Когда срабатывает                                |
| -------------------- | ------------------------------------------------ |
| `sdk.ready`          | Хендшейк прошёл — есть `userContext` и `idToken` |
| `sdk.error`          | SDK сломался, дальше не работает                 |
| `session.expired`    | Сессия истекла — нужен повторный `init()`        |
| `session.refreshed`  | Токен обновился — свежий `idToken` в payload     |
| `operation.rejected` | Пользователь отклонил операцию в кошельке        |
| `backButton`         | Нажата стрелка «Назад» в шапке кошелька           |

### Ошибки SDK

Ловите через `instanceof`: `AWInitError`, `AWSessionError`, `AWScopeError`, `AWOperationError`, `AWTimeoutError`.

Полный файл: [`src/app/scenarios/auth.component.ts`](./src/app/scenarios/auth.component.ts)

---

## 2. Вход (авторизация)

Пользователь нажимает кнопку → SDK делает хендшейк → фронт получает `idToken` →
шлёт его на ваш бэкенд → бэкенд проверяет подпись и возвращает `userId`.

`userId` — это `sub` из токена: строка-идентификатор **в вашем приложении**,
не номер аккаунта AW и не то, что нарисовано в `userContext`.

Имя и аватар (`userContext`) — **только для UI**. На бэкенде им нельзя доверять:
их прислал браузер, их можно подменить.

### Фронт

```ts
async function verifyIdentity(idToken: string) {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { userId } = await res.json();
  // userId = sub из токена: ключ вашей сессии, не «id с экрана»
}
```

### Бэкенд

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(
  new URL("/api/v2/sdk/jwks", process.env.AW_API_BASE),
);

app.post("/api/auth/session", express.json(), async (req, res) => {
  const { payload } = await jwtVerify(req.body.idToken, jwks, {
    issuer: "aw",
    audience: process.env.AW_APP_ID,
  });
  const userId = String(payload.sub);
  // sub — id пользователя в ЭТОМ приложении (строка), не номер аккаунта AW
  if (!userId) return res.status(401).json({ error: "INVALID_ID_TOKEN" });
  return res.json({ ok: true, userId });
});
```

Полный файл: [`src/app/scenarios/auth.component.ts`](./src/app/scenarios/auth.component.ts)

---

## 3. Платёж (донат)

Фронт **не** обращается к API кошелька напрямую. Он просит **ваш** сервер
создать интент, получает `operationId`, и показывает лист подтверждения в кошельке.

### Фронт

```ts
async pay(amount: string) {
  const instance = this.sdk;
  const idToken = instance?.idToken;
  if (!instance || !idToken) throw new Error('SDK не готов');

  const res = await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, type: 'pay', amount }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { operationId } = await res.json();

  const result = await instance.operations.requestConfirmation(operationId);
  // result.status: 'confirmed' | 'rejected' | ...
}
```

### Бэкенд

```js
app.post("/api/intents", express.json(), async (req, res) => {
  const { payload } = await jwtVerify(req.body.idToken, jwks, {
    issuer: "aw",
    audience: process.env.AW_APP_ID,
  });
  const userAppLogin = String(payload.sub);
  if (!userAppLogin) return res.status(401).json({ error: "INVALID_ID_TOKEN" });

  const body = JSON.stringify({
    type: req.body.type, // 'pay'
    user_app_login: userAppLogin, // из токена, НЕ из req.body
    data: { amount: req.body.amount },
  });

  const upstream = await fetch(
    `${process.env.AW_API_BASE}/api/apps/v1/intents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Aw-App-Id": process.env.AW_APP_ID,
        Authorization: `Bearer ${process.env.AW_API_SECRET}`,
      },
      body,
    },
  );

  const parsed = await upstream.json();
  if (!upstream.ok)
    return res
      .status(upstream.status)
      .json({ error: parsed?.message ?? "UPSTREAM_ERROR" });
  return res.json({
    operationId: parsed.data?.operationId ?? parsed.operationId,
  });
});
```

Полный файл: [`src/app/scenarios/pay.component.ts`](./src/app/scenarios/pay.component.ts)

---

## 4. Покупка и возврат

Тот же эндпоинт `/api/intents`, отличается только `type`:

- **Купить** → `type: 'pay'`. Пользователь ещё нажмёт «подтвердить» в кошельке.
- **Вернуть** → `type: 'receive'`. Деньги уходят сразу, листа в кошельке нет.
  Смотрите `status` в ответе сервера (`approved` / `failed`).

`receive` — это тип операции, а не скоуп, и он не требует никакого скоупа.
Кошелёк выдаёт только `userData`, `balance` и `pay`; этот сценарий просит
`userData` и `pay` ради покупки, а не ради возврата.

### Фронт

```ts
async createIntent(type: 'pay' | 'receive', amount: string) {
  const idToken = this.sdk?.idToken;
  if (!idToken) throw new Error('SDK не готов');

  const res = await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, type, amount }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as {
    operationId: string;
    status?: string;
    failureReason?: string;
  };
}

async buy(amount: string) {
  const instance = this.sdk;
  if (!instance) throw new Error('SDK не готов');
  const { operationId } = await this.createIntent('pay', amount);
  const result = await instance.operations.requestConfirmation(operationId);
  if (result.status === 'confirmed') {
    // Сохранить заказ как оплаченный на своём бэкенде
  }
}

async refund(amount: string) {
  const { status, failureReason } = await this.createIntent('receive', amount);
  if (status === 'approved') {
    // Сохранить заказ как возвращённый на своём бэкенде
  } else {
    throw new Error(failureReason ?? status ?? 'receive failed');
  }
}
```

### Бэкенд

Тот же `POST /api/intents` из раздела 3. Сервер принимает `type: 'pay'` или
`type: 'receive'` — заголовки те же.

В проде статус заказа храните **на своём бэкенде** и закрывайте через вебхук.

Полный файл: [`src/app/scenarios/pay-refund.component.ts`](./src/app/scenarios/pay-refund.component.ts)

---

## Важные правила

1. **Секрет только на сервере.** `AW_API_SECRET` никогда не попадает в браузер.
2. **Пользователь — `sub` из проверенного `idToken`.** Имя и аватар из SDK не доказательство.
3. **Интент создаёт сервер.** Для `pay` фронт показывает лист в кошельке; `receive` уже выполнен в ответе.
4. **В AW уходит `user_app_login` (= `sub`).** Не `user_id` и не то, что прислал браузер.

---

Пакет SDK: [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk)
Исходники и документация SDK (EN/RU): [antarctic-tech/aw-sdk](https://github.com/antarctic-tech/aw-sdk).
