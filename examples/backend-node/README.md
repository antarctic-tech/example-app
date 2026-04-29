# Example DApp — Node.js backend

Reference server for the Antarctic Wallet B2B intents flow. Runs on Node 18+
with no third-party dependencies (uses built-in `http`, `crypto`, and `fetch`).

## What it does

- Holds `AW_API_KEY` and `AW_API_SECRET` server-side so the browser never sees
  them.
- Exposes a small HTTP API the mini-app calls from the browser:
  - `POST /api/intents` — accepts `{ type, telegramUserId, amount?, scopes? }`,
    signs it with HMAC-SHA256, forwards to `${AW_API_BASE}/api/apps/v1/intents`,
    and returns the upstream response untouched.
  - `GET /health` — liveness probe.

## Quick start

```bash
cp .env.example .env
# edit .env — set AW_API_BASE / AW_API_KEY / AW_API_SECRET
npm start
```

Or with hot-reload while developing:

```bash
npm run dev
```

## Calling it from the mini-app

```ts
const res = await fetch('https://your-backend.example/api/intents', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'pay',
    telegramUserId: 999888777,
    amount: '5.00',
  }),
});
const intent = await res.json();
// intent.data.operationId — pass to sdk.operations.requestConfirmation(...)
```

## Request signing

The signature header is computed exactly as documented:

```
X-Sdk-App-Signature = hex(HMAC-SHA256(api_secret, `${ts}.${METHOD}.${path}.${sha256(body)}`))
```

with `path = '/api/apps/v1/intents'`. Drift > 5 minutes returns
`STALE_REQUEST` (401) from AW.

