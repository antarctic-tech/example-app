# Mini-app backend (Node.js)

[Русский](./README.ru.md) · **English**

This is **your** server, not the Antarctic Wallet (AW) API.

The wallet gives you three things: the SDK inside the iframe, the keys to verify
the user's JWT, and an API for payments made from your server. Everything else
(orders, catalogue, sessions) is yours. [`server.mjs`](./server.mjs) is a
reference implementation. Copy it; do not invent platform routes like
`/api/donate`.

```
Wallet (AW)                    Mini app (browser)            This server
iframe + native confirmation   frontend + aw-sdk             secrets, sessions
                               fetch('/api/...')  ─────────► JWT verification
                                                             Bearer POST to AW
```

Requires Node 20+.

---

## Quick start

```bash
cp .env.example .env
# fill in AW_API_BASE / AW_APP_ID / AW_API_SECRET
npm install
npm start
```

`npm start` is `node --env-file=.env server.mjs`. The code does not parse `.env`
itself — Node does. In Docker the file is not baked into the image; the values
are passed with `-e`.

Check: [http://127.0.0.1:3351/health](http://127.0.0.1:3351/health) → `{"ok":true}`.

Logs go to that terminal: `[boot]`, `[auth]`, `[intents]`, `[webhook]`.
Reload on changes: `npm run dev`.

The frontend (`vue` :5184, `react` :5185, `angular` :5186) proxies `/api` here.
In AW, in the mini-app settings, **App URL** is the address of the **frontend**
(`https://127.0.0.1:5184`), not this port.

If the log contains `(static from .../public)`, Express is also serving a built
mini app from `public/` (that is what Docker does). You do not need it in local
development: look at the UI on Vite/ng, and let only `/api` and `/health` come
here.

---

## Where the secrets go

Only into `.env` (locally) or the process env (Docker, orchestrator). Never into
the frontend and never into a request body coming from the browser.

```
# API origin without the /api suffix
AW_API_BASE=https://app.antarcticwallet.com
AW_APP_ID=your-app-id
AW_API_SECRET=…
PORT=3351
ALLOWED_ORIGIN=*
# STATIC_DIR=/path/to/dist  # optional, serve a folder for non-API paths
```

| Variable         | Why                                                                   |
| ---------------- | --------------------------------------------------------------------- |
| `AW_API_BASE`    | AW API origin, **without** a trailing `/api`                          |
| `AW_APP_ID`      | The `appId` from the dashboard, sent as `X-Aw-App-Id` (same value as in `config.json`) |
| `AW_API_SECRET`  | App secret: used both for requests to AW and to verify webhooks. Never ship it to the frontend — anyone could then create payments in your name |
| `PORT`           | This server's port. `3351` in the example                             |
| `ALLOWED_ORIGIN` | Value for `Access-Control-Allow-Origin`. `*` in the example; pin it to your origin in production |
| `STATIC_DIR`     | Optional folder served for non-API paths (this is how the Docker image serves the built mini app) |

Bad: `https://api.example.com/api` — the intent would go to
`/api/api/apps/v1/intents`. Good: `https://api.example.com`.

---

## What this server does

Three routes. The browser only ever calls the first two. The third is AW writing
to you when an operation finishes.

### `GET /health`

Is the process alive. Returns `{"ok": true}`. Open it in a browser if you are
not sure the server came up.

### `POST /api/auth/session` — who this user is

After sign-in the SDK hands the frontend an `idToken` — the wallet's signed JWT.
The frontend posts it here. The server verifies the signature against AW's keys
(`${AW_API_BASE}/api/v2/sdk/jwks`), that the token was issued by AW
(`iss === 'aw'`) and that it is meant for your app (`aud === appId`).

Inside the token, `sub` is the **user's id inside your application**. It is a
random hex string (`user_app_login`), not an AW account number. The same person
gets a different `sub` in a different mini app. If the user revokes access and
comes back, the `sub` will be new.

That `sub` is the key for your session / database record.

Request: `{ "idToken": "<sdk.idToken>" }`
Response:

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

`userId` and `userAppLogin` are the same value (`sub`). `hasKyc` / `hasKycData`
/ `kycCountry` are present only if the app asked for the `userData` scope. There
is no phone number, email or global AW id in the token.

The name and avatar from the SDK (`userContext`) must **never** be used for
authentication on the backend: that is a message from an iframe and the client
can substitute someone else's fields.

### `POST /api/intents` — create a payment or a refund

The frontend does not call AW itself. It tells your server: "create an
operation". The server verifies the JWT again, takes `sub` and calls AW **with
the secret**.

| `type`    | Meaning                        | What to pass         | What happens next |
| --------- | ------------------------------ | -------------------- | ----------------- |
| `pay`     | The user pays you              | `amount`             | The frontend calls `requestConfirmation` — a sheet in the wallet |
| `receive` | You pay the user               | `amount`             | The money leaves immediately, no sheet, no scope required. The response is already `approved` or `failed` |
| `scopes`  | Ask for more permissions       | `scopes`: `["pay"]`  | Same as `pay`: a sheet in the wallet |

Request from the frontend (no secrets here):

```json
{ "idToken": "<sdk.idToken>", "type": "pay", "amount": "5.00" }
```

Response for `pay`: `{ "operationId": "…", "status": "pending" }`.
For `receive`: `{ "operationId": "…", "status": "approved" }` or `failed`
(with `failureReason` in that case).

Whatever the client sent as `user_id` / `user_app_login` / `apiSecret` —
ignore it. Only the `user_app_login` from the verified token goes to AW. If you
send the old `user_id` field, AW answers `422 USER_ID_NOT_ACCEPTED`.

`reference_id` is **your** order id. Set it on the server, never from the
browser. For `receive` it is mandatory: without it a retried request (timeout,
retry) can transfer the money a second time. Same id and same data → AW returns
the existing intent. Same id but a different amount → `409 REFERENCE_ID_CONFLICT`.

### `POST /api/webhooks` — AW reports the outcome

This is not the browser. When the user has confirmed or rejected the operation
(or a `receive` has executed), AW posts to the URL you configured in the
dashboard (`webhook_url`).

Verify the signature with the same `AW_API_SECRET` you use for Bearer requests.
Headers: `X-Sdk-Webhook-Timestamp`, `X-Sdk-Webhook-Signature`.
Signature: HMAC-SHA256 of the secret over the string
`"{timestamp}.{sha256(raw body)}"`. Compute it over the **raw bytes**, not over
`JSON.parse` output — otherwise the signature will not match. If your clock and
AW's differ by more than 5 minutes, reject the request.

Events:

| Event | When |
| ----- | ---- |
| `intent.approved` / `intent.rejected` | The user tapped in the wallet |
| `payment.succeeded` / `payment.failed` | An automatic `receive` |

The body carries `user_app_login` (the same `sub`), not a global id. In
production, mark the order **here**, and do not process the same
`operation_id` + `event` twice. What the frontend got back from
`requestConfirmation` is not good enough for accounting: the tab can be closed.

---

## How the frontend calls this

After `sdk.init()`:

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

The frontend dev server proxies `/api` to this backend. No secrets take part in
these requests.

---

## This server → AW

```
POST ${AW_API_BASE}/api/apps/v1/intents

X-Aw-App-Id:     AW_APP_ID
Authorization:   Bearer AW_API_SECRET
```

Body (a `pay` example):

```json
{ "type": "pay", "user_app_login": "a1b2c3d4e5f60718", "data": { "amount": "5.00" } }
```

`user_app_login` is the `sub` from the JWT, as a string. A numeric `user_id`
must not be sent. In AW's response `operationId` may arrive as
`data.operationId` or `data.operation_id` — the example understands both. Next
to it is `status`: `pending`, `approved` or `failed`.

For `pay`, the money moves from the user's balance to the balance of your app
inside AW (the one whose `appId` and secret are in the request). `receive` is
the opposite, and happens immediately, with no confirmation screen.

---

## Rules you must not break

1. The secret (`AW_API_SECRET`) stays on the server, never in the frontend.
2. The user is the `sub` from a verified `idToken`. The name and avatar from the
   SDK prove nothing.
3. The field sent to AW is `user_app_login` (= `sub`), not `user_id`.
4. `pay` is confirmed by a human in the wallet. `receive` is already done by the
   time the server responds.
5. In production, settle the order from the webhook, not from what the browser
   reported.

Reference implementation: [`server.mjs`](./server.mjs).
