# Antarctic Wallet mini-apps

[Русский](./README.ru.md) · **English** · [SDK](https://github.com/antarctic-tech/aw-sdk)

You already have an app. This repository shows how to embed it into Antarctic
Wallet as a **mini app**: the user opens the wallet, sees your app inside, signs
in and (if needed) pays. Confirmation always happens in the wallet's native UI,
never in your markup.

| Stack   | Example                                            |
| ------- | -------------------------------------------------- |
| Vue     | [examples/vue](./examples/vue)                     |
| React   | [examples/react](./examples/react)                 |
| Angular | [examples/angular](./examples/angular)             |
| Backend | [examples/backend-node](./examples/backend-node)   |

Open the folder for your stack — its README covers the scenarios and how to run
them (those are written in Russian; this file is the full English reference).
Running locally without Docker: [Local run](#local-run-without-docker).
Container: [Deploying with the Dockerfile](#deploying-with-the-dockerfile).
The steps below are the same for every framework.
For agents and AI tooling: [AGENTS.md](./AGENTS.md).

---

## How it works

Three parties. Do not merge them.

```
Wallet (AW)           Mini app (browser)         YOUR backend
───────────           ──────────────────         ────────────
iframe + UI           your frontend + SDK        secret, sessions
confirmation          postMessage to wallet      calls to the AW API
```

1. The wallet opens your frontend in an iframe.
2. The frontend loads [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk)
   (requires **>= 0.4.0**) and calls `init`.
3. Payments and scopes on the AW side are created by **your server**
   (`POST /api/apps/v1/intents`). The browser never sees the secret.
4. The frontend only asks the wallet to show the confirmation sheet:
   `sdk.operations.requestConfirmation(operationId)`.

The secret (`api_secret`) lives only on your server. If it ends up in the
frontend, this is no longer an example — it is a hole.

Where the credentials from the AW dashboard go:

| What                                                | Where                                 |
| --------------------------------------------------- | ------------------------------------- |
| `appId`                                             | `public/config.json` → `id` of the mini app, and the backend's `AW_APP_ID` |
| `AW_API_BASE`, `AW_APP_ID`, `AW_API_SECRET`         | the **backend's** `.env` (the same secret verifies webhooks) |

---

## 1. Wiring the SDK

The same code for Vue, React or no framework at all.

```ts
import { AWSDK } from "@antarctic-wallet/aw-sdk";

const sdk = new AWSDK({
  appId: "your-app-id",
  scopes: ["userData"],       // what you ask the user for at sign-in
  parentOrigin: parentOrigin, // the wallet origin, see below
  persistSession: true,
});

sdk.events.on("sdk.ready", (session) => {
  // session.userContext — display name, avatar: UI only
  // sdk.idToken — signed JWT: send it to YOUR backend
});

await sdk.init();
```

`parentOrigin` exists so that `postMessage` only ever reaches the wallet:

1. `?parentOrigin=...` in the URL (this is what the wallet passes),
2. otherwise `document.referrer`,
3. otherwise the origin of your dev wallet.

Call `sdk.destroy()` in `onUnmounted` / `beforeunload`.

### Scopes

The wallet grants exactly three scopes — the same set lives in the `AWScope` enum:

| Scope      | What it gives                                                          |
| ---------- | ---------------------------------------------------------------------- |
| `userData` | Profile and KYC flags (`hasKyc`, `hasKycData`, `kycCountry`) in the `idToken` |
| `balance`  | The user's balance                                                     |
| `pay`      | The user pays you                                                      |

`receive` is not a scope: it is an intent type (you paying the user), and it
requires no scope at all. The refund scenario asks for `userData` and `pay`
because of the purchase that precedes the refund, not because of the refund.

```ts
import { AWScope } from "@antarctic-wallet/aw-sdk";

scopes: [AWScope.USER_DATA, AWScope.PAY]; // same thing as ["userData", "pay"]
```

To ask for more scopes after sign-in, create an intent with `type: "scopes"` —
it is confirmed exactly like a payment, and the SDK then emits `scopes.granted`.

### Opened outside the wallet

```ts
if (!AWSDK.isInsideWallet()) {
  // a plain browser tab — show an "open me in Antarctic Wallet" screen
}
```

### Events

Subscribe **before** `init()`. Sign-in needs the first three;
`operation.rejected` matters once you take payments.

| Event                | When                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `sdk.ready`          | Handshake succeeded. Session, `userContext` and `idToken` exist. |
| `sdk.error`          | The SDK is dead: bad origin, host unreachable, `init` failed.    |
| `session.expired`    | The session is gone — a new `init` is needed.                    |
| `session.refreshed`  | The token rotated; the payload carries a fresh `idToken`.        |
| `scopes.granted`     | The user granted additional scopes.                              |
| `operation.rejected` | The user tapped "reject" in the wallet.                          |
| `backButton`         | The back arrow in the wallet header was pressed.                 |

```ts
sdk.events.on("sdk.ready", (session) => {
  // session.userContext — UI only; sdk.idToken — for your backend
});
sdk.events.on("sdk.error", ({ code, message }) => {
  /* show an error, the SDK will not work from here on */
});
sdk.events.on("session.expired", () => {
  /* reset the UI, call sdk.init() again */
});
sdk.events.on("session.refreshed", ({ idToken }) => {
  /* if you cached idToken, take the new one */
});
sdk.events.on("scopes.granted", ({ scopes }) => {
  /* the user granted more scopes */
});
sdk.events.on("operation.rejected", ({ operationId, reason }) => {
  /* cancelled in the wallet — do not confuse with AWOperationError */
});

await sdk.init(); // subscriptions are already in place
```

### SDK errors

`init` and `requestConfirmation` throw classes. Catch them with `instanceof`,
not by matching `error.message`.

| Class              | When                                                    |
| ------------------ | -------------------------------------------------------- |
| `AWInitError`      | `init` failed (handshake, config, timeout).              |
| `AWSessionError`   | The session is invalid or expired.                       |
| `AWScopeError`     | A required scope was not granted.                        |
| `AWOperationError` | Operation error — carries `operationId` and `errorCode`. |
| `AWTimeoutError`   | The request took longer than the SDK's `timeout`.        |

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
    /* show "could not sign in" */
  } else if (error instanceof AWTimeoutError) {
    /* network / the wallet did not answer */
  } else if (error instanceof AWOperationError) {
    /* error.operationId, error.errorCode */
  } else throw error;
}
```

---

## 2. Who the user is

After sign-in the SDK gives you two different things:

- `userContext` — display name, avatar. This is for the screen. The browser can
  forge these fields, so the backend **does not trust them**.
- `idToken` — the wallet's signed JWT. This is what you send to **your** server.

```ts
// frontend, after sdk.ready
await fetch("/api/auth/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ idToken: sdk.idToken }),
});
```

The server verifies the token really came from AW (keys at
`${AW_API_BASE}/api/v2/sdk/jwks`, issuer `aw`, audience your `appId`) and takes
`sub`. That is the user's id **inside your application** (the
`user_app_login` string), not their AW account number. Key your session on it.

If you asked for the `userData` scope, the token also carries KYC flags:
`hasKyc`, `hasKycData`, `kycCountry`. There is no phone number or email in it.

Reference: `POST /api/auth/session` in [examples/backend-node](./examples/backend-node).

---

## 3. Payment

The frontend does **not** call AW to create a payment. It asks your server.

```
Mini app                    YOUR backend                    AW
   │   idToken + amount         │                             │
   │ ─────────────────────────► │                             │
   │                            │  POST /api/apps/v1/intents  │
   │                            │  { type, amount }           │
   │                            │ ──────────────────────────► │
   │         operationId        │                             │
   │ ◄───────────────────────── │                             │
   │
   │  sdk.operations.requestConfirmation(operationId)
   ▼
Wallet: the user taps "confirm" or "reject"
```

Intent types:

| `type`    | Meaning                                          | Confirmation             |
| --------- | ------------------------------------------------ | ------------------------ |
| `pay`     | The user pays you (purchase, donation)           | yes, a sheet in the wallet |
| `receive` | You send money to the user (refund, payout)      | no, already done in the response; needs no scope |
| `scopes`  | Additional permissions                           | yes, a sheet in the wallet |

A small frontend example (the `/api/intents` URL is **your** server, not AW):

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

Only the server sets the AW headers:

```
X-Aw-App-Id: <appId>
Authorization: Bearer <AW_API_SECRET>
```

In the body sent to AW the user field is `user_app_login`. That is the `sub`
from the verified token, not whatever arrived from the browser. AW rejects the
old `user_id` field (`422 USER_ID_NOT_ACCEPTED`). Building the request on Node
is covered in the backend README.

The order id (`reference_id`) is also set on the server. For a refund
(`receive`) it is mandatory: without it a retried request can send the money
twice.

Once the user has tapped in the wallet, AW itself posts to your `webhook_url`:
`intent.approved` or `intent.rejected`. For an automatic `receive` there are
also `payment.succeeded` / `payment.failed`. Signed with the same
`AW_API_SECRET`. Settle the order from that webhook, not from what the tab
reported.

Keep the order (paid / refunded) **on your side**. The wallet only moves the
money; it is not your order database.

---

## Back button

`sdk.backButton.show()` swaps "Close" in the wallet header for a back arrow;
`hide()` restores it. Pressing it only delivers an event to your app —
navigation is entirely on your side and the container stays open.

```ts
sdk.backButton.onClick(() => router.back());
sdk.backButton.show();
```

On Android the hardware back button behaves the same way while the arrow is
visible. `sdk.destroy()` hides the arrow and drops the handlers.

---

## Mini-app config

`public/config.json` (the field names are the same in every stack):

```json
{
  "id": "your-app-id",
  "name": "My mini app",
  "shortDescription": "One line, for the catalogue",
  "description": "Full description on the app page inside the wallet.",
  "icon": "./icon.svg",
  "category": "utilities",
  "requiredScopes": ["userData", "pay"]
}
```

The handshake needs `id` and the scopes. `id` comes from this file; the SDK
scopes are a constant in the scenario file, not `requiredScopes`. The rest of
the fields are read by the wallet catalogue.

| Field              | Required     | Why                                                                         |
| ------------------ | ------------ | ---------------------------------------------------------------------------- |
| `id`               | yes          | The `appId` from the AW dashboard. Passed to `new AWSDK({ appId })`          |
| `name`             | for catalogue | The name shown in the wallet UI                                             |
| `shortDescription` | for catalogue | One line in the app list                                                    |
| `description`      | for catalogue | Long text on the app card                                                   |
| `icon`             | for catalogue | Icon path relative to `public/` (for example `./icon.svg`)                  |
| `category`         | for catalogue | Category slug: `utilities`, `defi`, `games`, …                              |
| `requiredScopes`   | yes*         | Manifest for the wallet catalogue. **Not** passed to `new AWSDK({ scopes })` |

\*In the `examples/vue` / `examples/react` / `examples/angular` starters the
scopes are a constant inside each scenario file. Keep `requiredScopes` anyway —
the catalogue reads it. The examples' manifest lists `["userData", "pay"]`,
which is the union of all three scenarios; your real set may be narrower.

---

## Rules you must not break

1. The secret lives only in the backend's env.
2. On the backend the user is the `sub` from a verified `idToken`, never the
   name or avatar from the SDK.
3. The server creates the intent. For `pay` the wallet shows a sheet; `receive`
   is already executed in the response.

SDK package: [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk).
SDK sources and reference (EN/RU): [antarctic-tech/aw-sdk](https://github.com/antarctic-tech/aw-sdk).

---

## Local run (without Docker)

Two processes: the backend and the frontend dev server. Stack-specific details
are in each example's README (`vue` / `react` / `angular`).

1. Backend: `examples/backend-node` → `cp .env.example .env` → fill in the keys
   you got from AW → `npm start`. It listens on `http://127.0.0.1:3351`.
   `npm start` picks up `.env` via `node --env-file=.env`. Logs go to that
   terminal.
2. Frontend: run `npm run dev` in your stack's folder.
   HTTPS on `127.0.0.1` (Vue `:5184`, React `:5185`, Angular `:5186`), with
   `/api` proxied to the backend.
3. In AW, in the mini-app settings, set **App URL** to `https://127.0.0.1:5184`
   (or your stack's port).

The wallet **does not accept** `localhost` — the hostname must contain a dot.
The wallet is served over HTTPS, so the mini app must be too (otherwise the
iframe is mixed content). Open the URL once in a browser and accept the
self-signed certificate.

---

## Deploying with the Dockerfile

There is one universal `Dockerfile` in the repository. It builds the **frontend
of the stack you choose** and drops it into `public` of `examples/backend-node`,
so that the mini app and `/api` are served from a single origin.

That is convenient for production:

1. the frontend is served as static files,
2. the backend handles `idToken` and intents,
3. the browser never needs any secrets,
4. the wallet opens a single URL.

### What matters

- `FRAMEWORK` picks which frontend to build: `vue`, `react` or `angular`.
- `AW_API_BASE`, `AW_APP_ID`, `AW_API_SECRET` are needed **only when running the
  container**. The same secret verifies incoming webhooks.
- `appId` is taken from the chosen example's `public/config.json` **at image
  build time**.

So: configure the frontend first, then build the image, then run the container
with the backend env variables.

### Before building

1. Pick a stack: `examples/vue`, `examples/react` or `examples/angular`.
2. Put your `appId` into that stack's `public/config.json`.
3. Prepare the values for `AW_API_BASE`, `AW_APP_ID`, `AW_API_SECRET`.

### Building the image

Run the build from the repository root.

```bash
docker build --build-arg FRAMEWORK=vue     -t mini-app:vue .
docker build --build-arg FRAMEWORK=react   -t mini-app:react .
docker build --build-arg FRAMEWORK=angular -t mini-app:angular .
```

If you would rather not memorise the default baked into the `Dockerfile`, just
**always pass `--build-arg FRAMEWORK=...` explicitly**.

### Running the container

```bash
docker run --rm -p 8080:8080 \
  -e AW_API_BASE=https://… \
  -e AW_APP_ID=your-app-id \
  -e AW_API_SECRET=… \
  -e PORT=8080 \
  mini-app:vue
```

### What you get

The container listens over HTTP. For the AW dashboard do **not** use
`localhost` (a hostname without a dot is rejected by the wallet).

- frontend: `http://127.0.0.1:8080`
- healthcheck: `http://127.0.0.1:8080/health`
- backend API:
  - `POST /api/auth/session`
  - `POST /api/intents`
  - `POST /api/webhooks` (AW → your server, not the browser)

In AW, **App URL** for a local check: `http://127.0.0.1:8080`. If the wallet is
served over HTTPS, the iframe will not load HTTP (mixed content) — put TLS in
front of the container (Caddy / nginx / mkcert) and use `https://127.0.0.1:…`
or your domain. In production use a normal HTTPS domain, not a loopback address.

Backend logs: `docker logs` for that container (`[boot]`, `[auth]`, `[intents]`).

### Checking that it came up

1. Open `http://127.0.0.1:8080`.
2. Make sure the examples' start page loaded.
3. Open `http://127.0.0.1:8080/health`:

```json
{ "ok": true }
```

4. Check the container logs: the server should be listening on `0.0.0.0:8080`.

### Common mistakes

#### 1. The frontend opens but payments do not work

Most likely these were not passed: `AW_API_BASE`, `AW_APP_ID`, `AW_API_SECRET`.

#### 2. The wallet does not open the mini app

**App URL** is set to `localhost` (no dot in the hostname), or it is HTTP while
the wallet is HTTPS. For a container without TLS use at least
`http://127.0.0.1:8080`; for an iframe inside an HTTPS wallet you need TLS in
front of the container.

#### 3. The wrong frontend got built

`--build-arg FRAMEWORK=...` was not passed at build time. Rebuild explicitly:

```bash
docker build --build-arg FRAMEWORK=react -t mini-app:react .
```

#### 4. Your `appId` is not in the container

`appId` is read from `public/config.json` **at build time**. If you changed
`config.json`, you must **rebuild the image**, not just restart the container.
