# AGENTS.md — Antarctic Wallet mini-app (machine spec)

Human docs: `README.ru.md` (RU) / `README.md` (EN). Do not rewrite those files for pedagogy.
This file is the source of truth for code generation.

Requires `@antarctic-wallet/aw-sdk` **>= 0.4.2**. SDK reference:
[antarctic-tech/aw-sdk](https://github.com/antarctic-tech/aw-sdk).

You are implementing a **partner mini-app**, not Antarctic Wallet (AW).
AW already exists. Copy the example; do not invent platform APIs.

## Hard constraints (MUST / MUST NOT)

MUST:

- Mini-app runs in the wallet iframe. Confirmations are native wallet UI, never custom HTML.
- Frontend: `@antarctic-wallet/aw-sdk` only. Handshake = `new AWSDK(...)`; subscribe; `await sdk.init()`.
- Grantable scopes are `userData` | `balance` | `pay` — the `AWScope` enum exported by the SDK. Nothing else is grantable. `receive` is an intent type and requires no scope at all.
- Identity on the backend = `sub` from a JWKS-verified `idToken` (`iss === 'aw'`, `aud === appId`). `sub` is opaque per-app `user_app_login` (16 hex), not a global numeric user id. With scope `userData` the token also carries `hasKyc`, `hasKycData`, `kycCountry`.
- Intents: YOUR server POSTs `${AW_API_BASE}/api/apps/v1/intents` with `X-Aw-App-Id` and `Authorization: Bearer`. Browser never sees `api_secret`.
- After `{ operationId, status }` for `pay` / `scopes`, frontend only calls `sdk.operations.requestConfirmation(operationId)`. `receive` is executed immediately; do not confirm it in the wallet.
- `user_app_login` in the AW body comes from verified JWT `sub`, never from request body / `userContext`. Sending `user_id` to AW returns `422 USER_ID_NOT_ACCEPTED`.
- Secrets: `AW_API_BASE`, `AW_APP_ID`, `AW_API_SECRET` only in backend `.env`. Webhooks (still in development) are HMAC-signed with the same `app_secret`.
- `appId` → mini-app `public/config.json` field `id` and backend `AW_APP_ID` (same value).
- Subscribe to SDK events **before** `init()`. Call `sdk.destroy()` on unmount.
- Catch SDK errors with `instanceof` (`AWInitError`, `AWSessionError`, `AWScopeError`, `AWOperationError`, `AWTimeoutError`, `AWScanQrError`, `AWOpenAppError`).
- Vue: store the SDK instance in `shallowRef`. React: `useRef`. Angular: a class field. Never put the SDK class into reactive/deep state. `@antarctic-wallet/aw-sdk/vue` exports `useAWSdk` (`init` on mount, `destroy` on unmount). Example scenarios do not use it: the login button retries `init()`. Copy the scenario.
- Nested screens: `onClick` **or** `events.on('backButton')` (not both — both fire) → `init()` (starts the postMessage listener; presses are dropped until it runs) → `backButton.show()`. `show()` / `hide()` before `init()` are queued and sent once the channel is open (after the handshake, or after a restored session). A retried handshake resends the arrow if it should stay visible. `hide()` before `destroy()`. Android hardware back follows the same contract while the arrow is visible.

MUST NOT:

- Put `api_secret` / `AW_API_SECRET` / Bearer credentials in the browser.
- Trust `userContext` / client `userId` for auth or payments (IDOR via postMessage).
- Call AW `POST /api/apps/v1/intents` from the frontend.
- Invent AW routes (`/api/donate`, `/api/orders`, `/api/refund`, etc.).
- Call `sdk.operations.prepare()` — removed in SDK 0.4.0. `sdk.operations` exposes `requestConfirmation()` only.
- Persist order paid/refunded state only in the browser in production (wallet is a rail, not your DB).

AW surface you may use (closed set):

- SDK in iframe: `init` / `destroy`, session (`idToken`, `user`, `getSession`, `status`, `refreshSession`), `startParam`, `scopes.getScopes` / `getData`, `operations.requestConfirmation`, `openApp`, `backButton`, host environment, `scanQr`, `hapticFeedback`, `setBackgroundColor`, `isCommandAvailable`
- JWKS: `GET ${AW_API_BASE}/api/v2/sdk/jwks`
- B2B: Bearer `POST ${AW_API_BASE}/api/apps/v1/intents` with `type: 'pay' | 'receive' | 'scopes'`
- B2B poll: `GET ${AW_API_BASE}/api/apps/v1/intents/:operationId_or_referenceId`
- B2B app balance: `GET ${AW_API_BASE}/api/apps/v1/balance` — the app account, not the user's `balance` scope
- Webhook (**in development**, not a stable contract): signed `intent.approved` / `intent.rejected` / `payment.succeeded` / `payment.failed` to YOUR `webhook_url` (HMAC with `app_secret`)

Partner domain (orders, catalog, your session cookies) lives on YOUR backend, not on AW.

## Copy map (pick one scenario file + the backend)

Single-app starters (hash router, login button, isolated scenarios):

| Stack   | Project            | Port |
| ------- | ------------------ | ---- |
| Vue     | `examples/vue`     | 5184 |
| React   | `examples/react`   | 5185 |
| Angular | `examples/angular` | 5186 |

Copy **one** scenario file into your app — not Home or the router shell.

| Goal                 | Vue                                                                     | React                          | Angular                                       | Scopes                                                |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------ | --------------------------------------------- | ----------------------------------------------------- |
| Sign-in only         | `vue/src/scenarios/Auth.vue`                                            | `react/src/scenarios/Auth.tsx` | `angular/src/app/scenarios/auth.component.ts` | `userData`                                            |
| Sign-in + pay/donate | `…/Pay.vue`                                                             | `…/Pay.tsx`                    | `…/pay.component.ts`                          | `userData`, `pay`                                     |
| Pay + refund         | `…/PayRefund.vue`                                                       | `…/PayRefund.tsx`              | `…/pay-refund.component.ts`                   | `userData`, `pay`                                     |
| Dynamic scopes       | `…/Scopes.vue`                                                          | `…/Scopes.tsx`                 | `…/scopes.component.ts`                       | checked set at login; later extras via `scopes`       |
| Open another app     | `…/OpenApp.vue`                                                         | `…/OpenApp.tsx`                | `…/open-app.component.ts`                     | `userData`                                            |
| Backend (always)     | `examples/backend-node/server.mjs` or `examples/backend-php/server.php` | same                           | same                                          | —                                                     |

`appId` → that project's `public/config.json` field `id` and backend `AW_APP_ID`.
Scopes are **constants inside each scenario file**, not from `config.requiredScopes`.
Each scenario: own `AWSDK` (Vue: `shallowRef`; React: `useRef`; Angular: class field); subscribe before `init()`; `init()` on scenario mount (needed for `backButton` presses; login button retries); `destroy()` on unmount. Scenario screens show the host back button and go to `/` on click; Home leaves it hidden (host shows Close) and shows `sdk.startParam` under the app name.
Router: hash (`#/auth`) so `?parentOrigin=` is preserved.
Dev proxies `/api` → `http://127.0.0.1:3351`.
Local mini-app App URL in AW settings: `https://127.0.0.1:<front-port>` (not `localhost`; hostname must contain `.`). `AW_API_BASE` is the API origin without a trailing `/api`.

## Architecture (3 parties, do not merge)

```
Wallet (AW)              Mini-app (browser)           YOUR backend
iframe + native UI       front + aw-sdk               env secrets, sessions
confirms operations      postMessage to parentOrigin  JWKS verify + POST intents
```

1. Wallet loads the mini-app in an iframe (`?parentOrigin=`).
2. Front: `fetch('./config.json')` → `new AWSDK({ appId: config.id, scopes: [...SCOPES], parentOrigin, persistSession: true })`. `SCOPES` is the constant in the scenario file, not `config.requiredScopes`.
3. Events, then `init()`. On `sdk.ready`: show `userContext` in UI; POST `sdk.idToken` to YOUR `/api/auth/session`.
4. Pay: POST YOUR `/api/intents` `{ idToken, type, amount }` → `{ operationId, status }`. If `status` is `pending`, call `requestConfirmation`. `receive` comes back already `approved`/`failed`.
5. `parentOrigin` resolution: `?parentOrigin=` → else `document.referrer` origin if in iframe → else `https://localhost:3310`. Keep launch params `awPlatform`, `awColorScheme`, `awLanguageCode` on that same query string (hash router). They are readable on `sdk.platform` / `colorScheme` / `languageCode` before `init()`.

## Contracts

### Mini-app → YOUR backend

`POST /api/auth/session`

```json
{ "idToken": "<sdk.idToken>" }
```

→ `{ "ok": true, "userId": "<sub>", "userAppLogin": "<sub>", "hasKyc": <bool|null>, "hasKycData": <bool|null>, "kycCountry": <string|null>, "expiresAt": <exp> }`

`POST /api/intents`

```json
{
  "idToken": "<sdk.idToken>",
  "type": "pay|receive|scopes",
  "amount": "5.00",
  "scopes": ["pay"]
}
```

- `amount` required for `pay` / `receive`
- `scopes` required for `type: "scopes"`
- Ignore any `apiKey` / `apiSecret` / `user_id` / `user_app_login` / `telegramUserId` / `referenceId` from the client

→ `{ "operationId": "<string>", "status": "pending|approved|failed", "failureReason": "<string>" }`

`GET /health` → `{ "ok": true }`

Reference: `examples/backend-node/server.mjs`

### YOUR backend → AW

```
POST ${AW_API_BASE}/api/apps/v1/intents
Content-Type: application/json
X-Aw-App-Id: $AW_APP_ID
Authorization: Bearer $AW_API_SECRET

{ "user_app_login": "<from sub>", "type": "pay|receive|scopes", "data": { "amount": "5.00" }, "reference_id": "order-1" }
```

`type: "scopes"` → `data: { "scopes": [...] }` instead of amount.
Never send `user_id` (422 `USER_ID_NOT_ACCEPTED`).
`reference_id` is YOUR order id (set on the server). Required for `receive`. 409 `REFERENCE_ID_CONFLICT` if reused with different data.
`receive` executes immediately; response `status` is already `approved` or `failed`.
Normalize `operationId` from `data.operationId` / `data.operation_id` / `operationId` / `operation_id`.

App account balance (same headers, no user, no `balance` scope):

```
GET ${AW_API_BASE}/api/apps/v1/balance
```

→ `[{ "asset": "USD", "total": { "amount": 100, "scale": 0 }, "available": { "amount": 70, "scale": 0 }, "locked": { "amount": 30, "scale": 0 } }]`

One element per currency; only `USD` for now. `available` is `max(total − locked, 0)`. Amounts are `{ amount, scale }` (100 whole units → `scale: 0`). `locked` is the cooling hold. The example server does not proxy this route.

JWT: `jose.jwtVerify(idToken, createRemoteJWKSet(${AW_API_BASE}/api/v2/sdk/jwks), { issuer: 'aw', audience: appId })`.

### AW → YOUR backend (webhook) — in development

Webhooks are not finished. Do not treat this as a stable API, do not build production order settlement on it, and do not invent a replacement AW callback. The block below is the current draft; the example only verifies the signature and logs the event.

Set `webhook_url` on the SdkApp (admin dashboard). Not browser-facing.

```
POST /api/webhooks
X-Sdk-Webhook-Timestamp: <unix seconds>
X-Sdk-Webhook-Signature: hex(HMAC-SHA256(AW_API_SECRET, `${ts}.${sha256(rawBody)}`))
```

Events: `intent.approved` / `intent.rejected` (wallet confirm), `payment.succeeded` / `payment.failed` (auto `receive`). Payload identity field is `user_app_login`.
Reject if drift > 5 min or signature mismatch. Dedupe on `data.operation_id` + `event`.

### SDK (frontend)

Constructor: `{ appId, scopes, parentOrigin, persistSession?: boolean, debug?: boolean, timeout?: 30000, retry?: { maxAttempts: 3, baseDelay: 1000 } }`

`persistSession` defaults to `true` (sessionStorage, per `appId`). `destroy()` clears it.
`retry` covers handshake / session / scopes. It is never applied to `requestConfirmation` (waits for a human) or `scanQr` (waits for a scan, a close, or `destroy()`). The config `timeout` does not apply to `scanQr`.

Events (subscribe before `init`):

| Event                       | Action                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sdk.ready`                 | UI from `session.userContext`; send `sdk.idToken` (null-check) to `/api/auth/session`                                               |
| `sdk.error`                 | Unsolicited host error, or `init()` failed; stop. An `ERROR` that answers a request rejects that call and does not emit `sdk.error` |
| `session.expired`           | Clear UI; `sdk.init()` again                                                                                                        |
| `session.refreshed`         | Replace stored `idToken`                                                                                                            |
| `scopes.granted`            | On ready (the granted set) and after a `scopes` operation                                                                           |
| `operation.rejected`        | User declined in wallet; also thrown as `AWOperationError` with `errorCode: 'user_rejected'`                                        |
| `backButton`                | Host back arrow pressed; you navigate, the container stays open                                                                     |
| `themeChanged`              | `sdk.colorScheme` changed (`light` / `dark`; system theme already resolved). No payload                                             |
| `languageChanged`           | `sdk.languageCode` changed (BCP 47). No payload                                                                                     |
| `safeAreaChanged`           | `sdk.safeAreaInset` changed (`{ top, right, bottom, left }`). No payload                                                            |
| `activated` / `deactivated` | App went on / off screen (`sdk.isActive`). No payload                                                                               |

`idToken` may be null while session is pending — do not POST it.

### Back button (optional)

`sdk.backButton.show()` swaps the host's "Close" for a back arrow; `hide()` restores it.
Pressing it only delivers `backButton` / `onClick` handlers — the host never navigates or
closes the container. `sdk.destroy()` hides the arrow and drops handlers.

```ts
sdk.backButton.onClick(() => router.push("/"));
const pending = sdk.init(); // listener starts here; show() before this is queued, not dropped
sdk.backButton.show();
await pending;
```

`backButton.offClick(handler)` removes one handler. `backButton.isVisible` is the last requested state.
Use `onClick` **or** `events.on('backButton')`, not both. Home / root: leave the button hidden (host shows Close). `hide()` before `destroy()`. `destroy()` also rejects in-flight requests (an open `scanQr` fails), drops `--aw-*` CSS variables, and clears `backgroundColor`.

### Opening another mini-app

`sdk.openApp({ appId })` asks the wallet to open a registered mini-app. The promise resolves when the wallet accepts the call. No scope is required for the call. The example still requests `userData` so the handshake matches the other screens. The example passes only `appId`.

The SDK rejects its own `appId` (`same_app`) locally; that call is not sent.

Host refusals arrive as `AWOpenAppError`: `not_found`, `blocked`, `suspended`, `stack_limit`, `rate_limited`. An older wallet without `open_app` throws `unsupported`. Check `sdk.isCommandAvailable(AWCommand.OpenApp)` after `init()`. A missing reply is `AWTimeoutError`.

The example screen is `#/open-app`. It needs an SDK build that exports `openApp`.

### Start parameter

`sdk.startParam` is the `start_param` of this opening. Read it after `init()`. It is not a launch-query field and not part of the session. Alphabet `A-Za-z0-9_-`, at most 512 characters. Missing, `null`, `""`, or an invalid string is `null` (invalid also `console.warn`); `init()` still resolves and `sdk.error` is not emitted. The SDK does not read `start_param` or `tgWebAppStartParam` from the page URL. The host sends it on `SDK_INIT_OK`, and on `SESSION_STATUS` when a session is restored. `refreshSession()` does not change it. `destroy()` clears it.

The example home screen shows it under the app name (`…` while the handshake runs, the string when present, `—` when empty). That screen calls `init()` with `scopes: []` and `persistSession: false`, leaves the host Close button, and does not call `init()` when `AWSDK.isInsideWallet()` is false.

### Host environment, scanner, haptics, background (0.4.2)

Properties before `init()`: `platform` (`web` | `tma` | `ios` | `android`), `colorScheme`, `languageCode`. `safeAreaInset` and `isActive` are filled by the time `init()` resolves. `isActive` starts `true` and stays `true` if the host never sends visibility. An older wallet that sends no snapshot does not block `init()` and does not emit `sdk.error`.

SDK writes `--aw-safe-area-inset-top|right|bottom|left` and `--aw-color-scheme` on `:root`. A variable is absent until the value arrives — always provide a CSS fallback. `refreshEnvironment()` re-asks for theme, language, and safe area only (visibility is push-only).

`scanQr(): Promise<string>` opens the wallet scanner and resolves with the decoded string. No caption argument. Rejects `AWScanQrError` (`errorCode`: `closed`, `not_active`, `already_open`, `camera_denied`, `unsupported`, `generic_error`). Call `sdk.isCommandAvailable(AWCommand.OpenScanQr)` first: optional commands need an explicit host entry, otherwise `scanQr` throws `unsupported`. If the host reported no `supportedCommands` map, required commands are assumed available; optional ones are not.

`hapticFeedback.impactOccurred('light' | 'medium' | 'heavy' | 'rigid' | 'soft')`, `notificationOccurred('success' | 'warning' | 'error')`, `selectionChanged()`. Fire-and-forget. Nothing happens while the app is inactive or the user disabled vibration. Older wallets ignore it.

`setBackgroundColor('#rgb' | '#rrggbb')` paints the WebView / iframe under the page (overscroll). Returns `false` for an invalid color and does not send. Short form is stored on `sdk.backgroundColor` as lowercase `#rrggbb`. No reply; older wallets ignore it. Call again on `themeChanged`.

### Outside the wallet

`AWSDK.isInsideWallet()` → `false` when the page is opened as a plain browser tab
(not an iframe / RN WebView). Render a "open me in Antarctic Wallet" screen instead of
calling `init()`.

## `public/config.json`

Required for handshake: `id`. SDK `scopes` come from the scenario constant, not `requiredScopes`.
Wallet catalog also reads `name`, `shortDescription`, `description`, `icon`, `category`, `requiredScopes`.

Scope sets:

- auth: `["userData"]`
- pay: `["userData", "pay"]`
- refund: `["userData", "pay"]` — for the purchase; the `receive` intent itself requires no scope
- scopes: checkboxes start empty. «Войти» handshakes with the checked set. Later extras go through a `scopes` intent. A granted scope cannot be revoked from the mini-app; the user removes scopes only by deleting the whole app.
- open-app: `["userData"]` — handshake only; `sdk.openApp` itself needs no scope

Ask only what the scenario needs.

## Implementation checklist

When generating a new mini-app:

1. Copy the matching scenario file from `examples/vue`, `examples/react`, or `examples/angular` (same SDK calls).
2. Copy `examples/backend-node/server.mjs` + `.env.example`. Do not add extra AW endpoints.
3. Set `config.json` `id` = dashboard `appId`. Set backend env. Never put secrets in the mini-app.
4. Keep `/api/auth/session` and `/api/intents` as the only browser-facing AW-related routes (names may change; behavior must not). Webhook is AW → YOUR server and is still in development.
5. Store orders on YOUR backend. Do not close paid/refunded state from the browser response. Do not close it from the webhook either until that channel leaves development.
6. Nested screens: back handler → `init()` → `backButton.show()`. `show()` / `hide()` before `init()` are queued. `hide()` before `destroy()`. Home / root: leave the host Close button.
