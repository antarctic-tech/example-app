# Example Embed App — AW SDK

Reference integrations for embed mini-apps that run inside [Antarctic Wallet] via [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk), plus a Node.js reference backend that signs B2B intent requests.

Three framework parity ports — **React 19 / Vue 3 / Angular 19** — that render the exact same UI and exercise the same SDK surface. Pick whichever stack you use in production, read a single file top-to-bottom, and copy the pieces you need.

## How it works

```
┌──────────────────────────┐                    ┌──────────────────────────┐
│  Antarctic Wallet (host) │ ◀── postMessage ──▶│  Embed app (this repo)   │
│  — session, signing, UI  │                    │  — your dApp inside      │
│  — user confirmations    │                    │    the wallet's iframe   │
└──────────────────────────┘                    └────────────┬─────────────┘
                                                             │
                                                             ▼ HTTP
                                              ┌──────────────────────────┐
                                              │  Your backend            │
                                              │  — holds api_secret      │
                                              │  — signs B2B requests    │
                                              │     to AW `/api/apps/v1` │
                                              └──────────────────────────┘
```

The wallet renders your app inside an `<iframe>` and passes its own origin via a query parameter. The embed app creates an `AWSDK` instance, which opens a typed `postMessage` channel, performs a handshake (`init`), and exposes session/scopes helpers. The user confirms operations in the wallet's native UI — never inside the iframe.

Operation intents (`pay` / `receive` / `scopes`) are created **server-to-server**: your backend holds the `api_secret`, signs each request with HMAC-SHA256, and `POST`s to `https://<aw>/api/apps/v1/intents`. The mini-app only triggers your backend; the secret never reaches the browser.

## Examples

| Stack         | Path                                              | Notes                          |
|---------------|---------------------------------------------------|--------------------------------|
| React 19      | [`examples/react`](./examples/react)              | Vite                           |
| Vue 3         | [`examples/vue`](./examples/vue)                  | Vite                           |
| Angular 19    | [`examples/angular`](./examples/angular)          | Angular CLI (`@angular/build`) |
| Node backend  | [`examples/backend-node`](./examples/backend-node)| Express, no extra deps         |

All three frontend examples behave identically — same config, same UI, same log output.

## Quick start

```bash
# Frontend (pick one)
cd examples/react      # or examples/vue, examples/angular
npm install
npm run dev            # starts the dev server

# Backend (in another terminal)
cd examples/backend-node
cp .env.example .env   # fill AW_API_BASE / AW_API_KEY / AW_API_SECRET
npm install
npm start
```

### Production build

```bash
npm run build          # output → ./dist
```

## Walkthrough of a single frontend example

Every `App` file is laid out the same way — sections in this order:

1. **Types** — `AppConfig`, `LogEntry`, `AppStatus` (`idle → connecting → ready / error`), `BackendIntentConfig`.
2. **Helpers**
   - `getParentOrigin()` — resolves the wallet origin: `?parentOrigin=…` → `document.referrer` → localhost dev-server.
   - `handleSdkError(e)` — narrows every SDK error class (`AWInitError`, `AWSessionError`, `AWScopeError`, `AWOperationError`, `AWTimeoutError`) into a readable log line.
   - `createBackendIntent(payload)` — POSTs the payload to `/api/intents` of YOUR backend, returns `operationId` + raw upstream response.
3. **SDK bootstrap** (runs once on mount / init):
   1. `AWSDK.isInsideWallet()` — detects iframe vs standalone run.
   2. `fetch('./config.json')` — reads `appId` + `requiredScopes`.
   3. `new AWSDK({ appId, scopes, parentOrigin, debug, retry, persistSession, timeout })`.
   4. Subscribes to every SDK event (see [Events](#sdk-events)).
   5. `await sdk.init()` — handshake with the host.
4. **App ID prompt** — on first load, the demo asks for the `appId` to use, persists it in `localStorage` (key `aw-demo:appId`), and lets the user override via `?appId=` in the URL. A `Change` button in the header resets it.
5. **Backend Intent panel** — DEMO UI for the B2B flow. Form fields (`API Base URL`, `API Key`, `API Secret`, `Bearer Token`, `Telegram User ID`) persist in `localStorage` (`aw-demo:backendIntent:v2`). The intent-type selector exposes `pay` / `receive` (with an `Amount` input). Clicking `Send` POSTs everything to `/api/intents` of the demo backend, which signs the HMAC and forwards to AW.
6. **Pending Intents panel** — once `apiBase` and `bearerToken` are filled in, the panel auto-polls `GET /api/v2/sdk/operations/intents` every 5 seconds and renders the list. Clicking an intent calls `sdk.operations.requestConfirmation(operationId)`, which opens the wallet's native approve/reject sheet.
7. **Identity panel (OIDC `idToken`)** — `verifyIdentity()` forwards `sdk.idToken` to the demo backend's `POST /api/auth/session`. The backend verifies the JWT signature against the host JWKS and returns the **trusted** `userId` (from the token's `sub`). Runs automatically on `sdk.ready` and via a `Verify identity (backend)` button. See [Authenticating the user](#authenticating-the-user-oidc-idtoken).

## App configuration — `public/config.json`

```json
{
  "id": "dev",
  "name": "Example DApp",
  "shortDescription": "Demo embedded application",
  "description": "A demo embedded application showcasing the AW SDK.",
  "icon": "./icon.svg",
  "category": "utilities",
  "requiredScopes": ["userData", "balance", "pay", "receive"]
}
```

| Field              | Purpose                                                                                |
|--------------------|----------------------------------------------------------------------------------------|
| `id`               | App identifier, passed to the wallet as `appId`. Must match what the wallet has registered. |
| `name`             | Display name in the wallet UI.                                                         |
| `shortDescription` | One-line description in app catalogs.                                                  |
| `description`      | Long description shown on the app's detail page.                                       |
| `icon`             | Icon path (relative to `public/`). Shown on the app tile.                              |
| `category`         | Category slug (e.g. `utilities`, `defi`, `games`).                                     |
| `requiredScopes`   | Scopes requested at init. The user is asked to approve them before the SDK becomes ready. |

## SDK surface used by the examples

### Bootstrap

```ts
const sdk = new AWSDK({
  appId: config.id,
  scopes: [...config.requiredScopes],
  parentOrigin: getParentOrigin(),
  debug: true,              // logs postMessage traffic to the console
  timeout: 30_000,          // per-request timeout in ms
  persistSession: true,     // restore the session token from storage on reload
  retry: { maxAttempts: 3, baseDelay: 1000 },
});

await sdk.init();
```

### SDK events

| Event                  | Fires when                                                             |
|------------------------|------------------------------------------------------------------------|
| `sdk.ready`            | Handshake complete. Payload: `AWSession` (token, expiry, scopes, user). |
| `sdk.error`            | Fatal SDK error (bad origin, host unreachable, init failed).           |
| `scopes.granted`       | User approved additional scopes.                                       |
| `session.refreshed`    | Token rotated (auto-refresh or manual `refreshSession()`). Payload carries a fresh `idToken`. |
| `session.expired`      | Session is no longer valid — re-initialise.                            |
| `operation.rejected`   | User declined to confirm an operation in the wallet.                   |

### Session

```ts
sdk.getSession();      // last known session token + scopes (sync, no postMessage)
await sdk.status();    // authoritative status from the host
await sdk.refreshSession();  // force-rotate the token
```

### Scopes

Scopes are **declared** up-front in `requiredScopes` and confirmed by the user during `sdk.init()`. Additional scopes can be requested later via a B2B intent of type `scopes`.

- `requiredScopes` in `config.json` — what the app asks for.
- `AWSession.grantedScopes` on `sdk.ready` / `scopes.granted` events — what the user actually granted.

### Error handling

The SDK throws typed errors — handle them explicitly:

| Error class        | When it's thrown                                      |
|--------------------|-------------------------------------------------------|
| `AWInitError`      | `sdk.init()` failed (handshake, config, timeout).     |
| `AWSessionError`   | Session invalid or expired.                           |
| `AWScopeError`     | Requested scope not granted.                          |
| `AWOperationError` | Operation-level error — has `operationId` + `errorCode`. |
| `AWTimeoutError`   | Request exceeded the configured `timeout`.            |

`handleSdkError()` in each example demonstrates the full `instanceof` narrowing pattern.

## Authenticating the user (OIDC `idToken`)

The `userContext` you receive on `sdk.ready` is **UI-only**. It arrives over
`postMessage`, so a malicious client can swap the `user_id` before it reaches
your backend — trusting it for auth is an IDOR. Identify the user from a signed
token instead:

```
┌──────────┐  idToken   ┌──────────────┐  fetch JWKS   ┌────────┐
│ Mini-app │ ─────────▶ │ YOUR backend │ ────────────▶ │  AWP   │
│ frontend │            │ verify sig + │   (public key)│  API   │
│sdk.idToken            │ trust `sub`  │ ◀──────────── │ /jwks  │
└──────────┘            └──────────────┘               └────────┘
```

1. Frontend sends `sdk.idToken` to your backend (`POST /api/auth/session`).
2. Backend verifies the RS256 signature against `${AW_API_BASE}/api/v2/sdk/jwks`
   (keys cached + rotated by `kid`), checks `iss === 'aw'`.
3. The verified `sub` claim is the trusted user id — issue your own session on it.

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(new URL(`${AW_API_BASE}/api/v2/sdk/jwks`));
const { payload } = await jwtVerify(idToken, jwks, { issuer: 'aw' });
const userId = payload.sub; // trusted — forging it breaks the signature
```

Runnable reference: [`examples/backend-node/server.mjs`](./examples/backend-node/server.mjs)
(`POST /api/auth/session`). `idToken` may be `null` while the session is pending —
null-check before forwarding.

## Backend B2B flow

> **Why this changed.** Earlier the mini-app frontend called
> `sdk.operations.prepare()`, which routed the intent through the wallet's
> session token. Anyone able to observe the iframe traffic could replay the
> request. The intent endpoint is now **server-to-server only** and the
> frontend never sees it. The mini-app SDK only handles the user-confirmation
> step.

The flow is three parties:

```
┌─────────┐     1. ask for intent      ┌──────────────┐  2. signed POST  ┌───────┐
│ Mini-app│  ─────────────────────────▶│ YOUR backend │ ───────────────▶ │  AWP  │
│ frontend│                            │              │  /api/apps/v1/   │  API  │
│         │ ◀─── 3. { operationId } ── │  HMAC sign   │      intents     │       │
└─────────┘                            └──────────────┘                  └───────┘
     │
     │ 4. sdk.operations.requestConfirmation(operationId)
     ▼
┌──────────┐
│  Wallet  │  shows native confirm UI → user approves → result returned to SDK
└──────────┘
```

### 1) Your backend — sign and create the intent

```http
POST /api/apps/v1/intents
Content-Type: application/json
X-Sdk-App-Key:       ak_…
X-Sdk-App-Timestamp: 1777331579
X-Sdk-App-Signature: <hmac-sha256-hex>

{
  "telegram_user_id": 999888777,
  "type": "pay",                         // 'pay' | 'receive'
  "data": { "amount": "50.00" }
}
```

```
signed     = `${timestamp}.POST./api/apps/v1/intents.${sha256(rawBody)}`
signature  = HMAC_SHA256(api_secret, signed) // hex
```

Drift > 5 minutes returns `STALE_REQUEST` (401). `api_key` / `api_secret` are issued per mini-app and **must never ship to the browser**.

Two reference implementations are shipped:

- [`examples/backend-node/server.mjs`](./examples/backend-node/server.mjs) — runnable Express service. The demo deploy hosts it at `POST /api/intents`, accepts `apiBase / apiKey / apiSecret` in the request body (DEMO ONLY) and forwards to AWP.
- `examples/{react,vue,angular}/src/integrator-backend.ts` — the same signing logic as a single-file TypeScript snippet you can copy into your own server-side handler.

### 2) Mini-app frontend — confirm the intent

```ts
// `operationId` came from your backend in step 1.
const result = await sdk.operations.requestConfirmation(operationId);
// result.status === 'confirmed' | 'rejected' | ...
// result.txId   (for on-chain operations)
```

### Demo shortcut

The deployed demo backend accepts `apiKey` / `apiSecret` from the request body so integrators can experiment without setting them in env, and tags the response with `X-Demo-Warning`. **Never do this in real apps** — your secret stays only on your server.

## Dependencies

| Stack          | Runtime deps                                                      | Dev deps                                            |
|----------------|-------------------------------------------------------------------|-----------------------------------------------------|
| React          | `react`, `react-dom`, `@antarctic-wallet/aw-sdk`                  | `vite`, `@vitejs/plugin-react`, `typescript`        |
| Vue            | `vue`, `@antarctic-wallet/aw-sdk`                                 | `vite`, `@vitejs/plugin-vue`, `sass`, `typescript`  |
| Angular        | `@angular/*`, `rxjs`, `zone.js`, `@antarctic-wallet/aw-sdk`       | `@angular/build`, `@angular/cli`, `typescript`      |
| Node backend   | `express`                                                         | —                                                   |
