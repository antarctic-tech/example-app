# AGENTS.md — Antarctic Wallet mini-app (machine spec)

Human docs: `README.md` (RU). Do not rewrite that file for pedagogy.
This file is the source of truth for code generation.

You are implementing a **partner mini-app**, not Antarctic Wallet (AW).
AW already exists. Copy the example; do not invent platform APIs.

## Hard constraints (MUST / MUST NOT)

MUST:

- Mini-app runs in the wallet iframe. Confirmations are native wallet UI, never custom HTML.
- Frontend: `@antarctic-wallet/aw-sdk` only. Handshake = `new AWSDK(...)`; subscribe; `await sdk.init()`.
- Identity on the backend = `sub` from a JWKS-verified `idToken` (`iss === 'aw'`).
- Intents: YOUR server HMAC-signs `POST ${AW_API_BASE}/api/apps/v1/intents`. Browser never sees `api_secret`.
- After `{ operationId }`, frontend only calls `sdk.operations.requestConfirmation(operationId)`.
- `user_id` in the AW body comes from verified JWT `sub` (positive integer), never from request body / `userContext`.
- Secrets: `AW_API_BASE`, `AW_API_KEY`, `AW_API_SECRET`, `AW_WEBHOOK_SECRET` only in backend `.env`.
- `appId` → mini-app `public/config.json` field `id`.
- Subscribe to SDK events **before** `init()`. Call `sdk.destroy()` on unmount.
- Catch SDK errors with `instanceof` (`AWInitError`, `AWSessionError`, `AWScopeError`, `AWOperationError`, `AWTimeoutError`).
- Vue: store the SDK instance in `shallowRef`. React: `useRef`. Angular: a class field. Never put the SDK class into reactive/deep state.

MUST NOT:

- Put `api_secret` / `AW_API_KEY` / HMAC signing in the browser.
- Trust `userContext` / client `userId` for auth or payments (IDOR via postMessage).
- Call AW `POST /api/apps/v1/intents` from the frontend.
- Invent AW routes (`/api/donate`, `/api/orders`, `/api/refund`, `sdk.operations.prepare()`, etc.).
- Persist order paid/refunded state only in the browser in production (wallet is a rail, not your DB).

AW surface you may use (closed set):

- SDK in iframe: `init`, session, scopes, `requestConfirmation`
- JWKS: `GET ${AW_API_BASE}/api/v2/sdk/jwks`
- B2B: HMAC `POST ${AW_API_BASE}/api/apps/v1/intents` with `type: 'pay' | 'receive' | 'scopes'`
- Webhook: signed `intent.approved` / `intent.rejected` to YOUR `webhook_url`

Partner domain (orders, catalog, your session cookies) lives on YOUR backend, not on AW.

## Copy map (pick one scenario file + the backend)

Single-app starters (hash router, login button, isolated scenarios):

| Stack | Project | Port |
|-------|---------|------|
| Vue | `examples/vue` | 5184 |
| React | `examples/react` | 5185 |
| Angular | `examples/angular` | 5186 |

Copy **one** scenario file into your app — not Home or the router shell.

| Goal | Vue | React | Angular | Scopes |
|------|-----|-------|---------|--------|
| Sign-in only | `vue/src/scenarios/Auth.vue` | `react/src/scenarios/Auth.tsx` | `angular/src/app/scenarios/auth.component.ts` | `userData` |
| Sign-in + pay/donate | `…/Pay.vue` | `…/Pay.tsx` | `…/pay.component.ts` | `userData`, `pay` |
| Pay + refund | `…/PayRefund.vue` | `…/PayRefund.tsx` | `…/pay-refund.component.ts` | `userData`, `pay`, `receive` |
| Backend (always) | `examples/backend-node/server.mjs` | same | same | — |

`appId` → that project's `public/config.json` field `id`.
Scopes are **constants inside each scenario file**, not from `config.requiredScopes`.
Each scenario: own `AWSDK` (Vue: `shallowRef`; React: `useRef`; Angular: class field); subscribe before `init()`; `init()` on login button in the example (callable on mount in prod iframe); `destroy()` on unmount.
Router: hash (`#/auth`) so `?parentOrigin=` is preserved.
Dev proxies `/api` → `http://127.0.0.1:3351`.
Local mini-app App URL in AW settings: `https://127.0.0.1:<front-port>` (not `localhost`; hostname must contain `.`). `AW_API_BASE` is the API origin without a trailing `/api`.

## Architecture (3 parties, do not merge)

```
Wallet (AW)              Mini-app (browser)           YOUR backend
iframe + native UI       front + aw-sdk               env secrets, HMAC, sessions
confirms operations      postMessage to parentOrigin  JWKS verify + POST intents
```

1. Wallet loads the mini-app in an iframe (`?parentOrigin=`).
2. Front: `fetch('./config.json')` → `new AWSDK({ appId: config.id, scopes: [...SCOPES], parentOrigin, persistSession: true })`. `SCOPES` is the constant in the scenario file, not `config.requiredScopes`.
3. Events, then `init()`. On `sdk.ready`: show `userContext` in UI; POST `sdk.idToken` to YOUR `/api/auth/session`.
4. Pay: POST YOUR `/api/intents` `{ idToken, type, amount }` → `{ operationId }` → `requestConfirmation`.
5. `parentOrigin` resolution: `?parentOrigin=` → else `document.referrer` origin if in iframe → else `https://localhost:3310`.

## Contracts

### Mini-app → YOUR backend

`POST /api/auth/session`

```json
{ "idToken": "<sdk.idToken>" }
```

→ `{ "ok": true, "userId": "<sub>", "tgId": <number|null>, "expiresAt": <exp> }`

`POST /api/intents`

```json
{ "idToken": "<sdk.idToken>", "type": "pay|receive|scopes", "amount": "5.00", "scopes": ["pay"] }
```

- `amount` required for `pay` / `receive`
- `scopes` required for `type: "scopes"`
- Ignore any `apiKey` / `apiSecret` / `user_id` / `telegramUserId` / `referenceId` from the client

→ `{ "operationId": "<string>" }`

`GET /health` → `{ "ok": true }`

Reference: `examples/backend-node/server.mjs`

### YOUR backend → AW

```
POST ${AW_API_BASE}/api/apps/v1/intents
Content-Type: application/json
X-Sdk-App-Key: $AW_API_KEY
X-Sdk-App-Timestamp: <unix seconds>
X-Sdk-App-Signature: hex(HMAC-SHA256(api_secret, `${ts}.POST./api/apps/v1/intents.${sha256(rawBody)}`))

{ "user_id": <from sub>, "type": "pay|receive|scopes", "data": { "amount": "5.00" }, "reference_id": "order-1" }
```

`type: "scopes"` → `data: { "scopes": [...] }` instead of amount.
`reference_id` is YOUR order id (set on the server; 409 `REFERENCE_ID_CONFLICT` if reused). Clock drift > 5 min → AW `401 STALE_REQUEST`.
Normalize `operationId` from `data.operationId` / `data.operation_id` / `operationId` / `operation_id`.

JWT: `jose.jwtVerify(idToken, createRemoteJWKSet(${AW_API_BASE}/api/v2/sdk/jwks), { issuer: 'aw' })`.
Production: also pass `audience: appId`.

### AW → YOUR backend (webhook)

Set `webhook_url` on the SdkApp (admin dashboard). Not browser-facing.

```
POST /api/webhooks
X-Sdk-Webhook-Timestamp: <unix seconds>
X-Sdk-Webhook-Signature: hex(HMAC-SHA256(webhook_secret, `${ts}.${sha256(rawBody)}`))
```

Events: `intent.approved` (pay/receive after transfer succeeded), `intent.rejected`.
Reject if drift > 5 min or signature mismatch. Dedupe on `data.operation_id` + `event`.

### SDK (frontend)

Constructor: `{ appId, scopes, parentOrigin, persistSession?: true, debug?: boolean }`

Events (subscribe before `init`):

| Event | Action |
|-------|--------|
| `sdk.ready` | UI from `session.userContext`; send `sdk.idToken` (null-check) to `/api/auth/session` |
| `sdk.error` | Fatal; stop |
| `session.expired` | Clear UI; `sdk.init()` again |
| `session.refreshed` | Replace stored `idToken` |
| `scopes.granted` | Update granted scopes |
| `operation.rejected` | User declined in wallet; not `AWOperationError` |

`idToken` may be null while session is pending — do not POST it.

## `public/config.json`

Required for handshake: `id`. SDK `scopes` come from the scenario constant, not `requiredScopes`.
Wallet catalog also reads `name`, `shortDescription`, `description`, `icon`, `category`, `requiredScopes`.

Scope sets:

- auth: `["userData"]`
- pay: `["userData", "pay"]`
- refund: `["userData", "pay", "receive"]`

Ask only what the scenario needs.

## Implementation checklist

When generating a new mini-app:

1. Copy the matching scenario file from `examples/vue`, `examples/react`, or `examples/angular` (same SDK calls).
2. Copy `examples/backend-node/server.mjs` + `.env.example`. Do not add extra AW endpoints.
3. Set `config.json` `id` = dashboard `appId`. Set backend env. Never put secrets in the mini-app.
4. Keep `/api/auth/session` and `/api/intents` as the only browser-facing AW-related routes (names may change; behavior must not). Webhook is AW → YOUR server.
5. Store orders on YOUR backend. Close status via webhook in production (`intent.approved` / `intent.rejected`), not via the browser response.
