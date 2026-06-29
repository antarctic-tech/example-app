# Example Embed App — AW SDK

Reference integrations for embed mini-apps that run inside [Antarctic Wallet] via [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk).

Three framework parity ports — **React 19 / Vue 3 / Angular 19** — that render the exact same UI and exercise the same SDK surface. Pick whichever stack you use in production, read a single file top-to-bottom, and copy the pieces you need.

## How it works

```
┌──────────────────────────┐                    ┌──────────────────────────┐
│  Antarctic Wallet (host) │ ◀── postMessage ──▶│  Embed app (this repo)   │
│  — session, signing, UI  │                    │  — your dApp inside      │
│  — user confirmations    │                    │    the wallet's iframe   │
└──────────────────────────┘                    └──────────────────────────┘
```

The wallet renders your app inside an `<iframe>` and passes its own origin via a query parameter. The embed app creates an `AWSDK` instance, which opens a typed `postMessage` channel, performs a handshake (`init`), and exposes methods for operations, scopes and session management. The user confirms payments/scopes in the wallet's native UI — never inside the iframe.

## Examples

| Framework  | Path                                     | Bundler                        |
|------------|------------------------------------------|--------------------------------|
| React 19   | [`examples/react`](./examples/react)     | Vite                           |
| Vue 3      | [`examples/vue`](./examples/vue)         | Vite                           |
| Angular 19 | [`examples/angular`](./examples/angular) | Angular CLI (`@angular/build`) |

All three behave identically — same config, same UI, same log output.

## Quick start

```bash
# pick one
cd examples/react      # or examples/vue, examples/angular
npm install
npm run dev            # starts the dev server
```

### Production build

```bash
npm run build          # output → ./dist
```

## Walkthrough of a single example

Every `App` file is laid out the same way — sections in this order:

1. **Types** — `AppConfig`, `LogEntry`, `AppStatus` (`idle → connecting → ready / error`).
2. **Helpers**
   - `getParentOrigin()` — resolves the wallet origin: `?parentOrigin=…` → `document.referrer` → localhost dev-server.
   - `handleSdkError(e)` — narrows every SDK error class (`AWInitError`, `AWSessionError`, `AWScopeError`, `AWOperationError`, `AWTimeoutError`) into a readable log line.
   - `KNOWN_COMMANDS` — list of `AWCommand.*` values used for version probing.
3. **SDK bootstrap** (runs once on mount / init):
   1. `AWSDK.isInsideWallet()` — detects iframe vs standalone run.
   2. `fetch('./config.json')` — reads `appId` + `requiredScopes`.
   3. `new AWSDK({ appId, scopes, parentOrigin, debug, retry, persistSession, timeout })`.
   4. Subscribes to every SDK event (see [Events](#sdk-events)).
   5. `await sdk.init()` — handshake with the host.
4. **Actions** — one method per UI button, calling the SDK.

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
| `scopes.granted`       | User approved additional scopes via a `scopes` operation.              |
| `session.refreshed`    | Token rotated (auto-refresh or manual `refreshSession()`).             |
| `session.expired`      | Session is no longer valid — re-initialise.                            |
| `operation.rejected`   | User declined to confirm an operation in the wallet.                   |

### Operations — `prepare → requestConfirmation`

All payable actions follow the same two-step pattern:

```ts
const intent = await sdk.operations.prepare({
  type: 'pay',          // 'pay' | 'receive' | 'scopes'
  amount: '5.00',
  currency: 'USDT',
  to: 'T...',
  description: 'Test payment',
  metadata: { orderId: 'demo-001' },
});

const result = await sdk.operations.requestConfirmation(intent.operationId);
// result.status === 'confirmed' | 'rejected' | ...
// result.txId  (for on-chain operations)
```

| Operation   | What it does                                                              |
|-------------|---------------------------------------------------------------------------|
| `pay`       | Transfers funds from the user's wallet to `to`. User confirms in wallet UI. |
| `receive`   | Generates a deposit intent (QR / address) for this app.                   |
| `scopes`    | Requests additional scopes at runtime (see `metadata.scopes`).            |

### Session

```ts
sdk.getSession();      // last known session token + scopes (sync, no postMessage)
await sdk.status();    // authoritative status from the host
await sdk.refreshSession();  // force-rotate the token
```

### Scopes

Scopes are **declared** up-front in `requiredScopes` and confirmed by the user during `sdk.init()`. Additional scopes can be requested later via a `scopes` operation. The embed app doesn't poll the host for its scope set — it already knows them from:

- `requiredScopes` in `config.json` — what the app asks for
- `AWSession.grantedScopes` on `sdk.ready` / `scopes.granted` events — what the user actually granted

```ts
// request extra scopes at runtime
await sdk.operations.prepare({
  type: 'scopes',
  metadata: { scopes: ['balance', 'pay'] },
  amount: '0', currency: 'USDT', to: '',
});
// → fires `scopes.granted` with the new list on approval
```

### Command versioning

```ts
sdk.isCommandAvailable(AWCommand.PrepareOperation);  // boolean
```

Use this to feature-gate calls against older wallet versions that might not implement newer commands yet.

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

## Dependencies

| Framework | Runtime deps                                                      | Dev deps                                   |
|-----------|-------------------------------------------------------------------|--------------------------------------------|
| React     | `react`, `react-dom`, `@antarctic-wallet/aw-sdk`                  | `vite`, `@vitejs/plugin-react`, `typescript`  |
| Vue       | `vue`, `@antarctic-wallet/aw-sdk`                                 | `vite`, `@vitejs/plugin-vue`, `sass`, `typescript` |
| Angular   | `@angular/*`, `rxjs`, `zone.js`, `@antarctic-wallet/aw-sdk`       | `@angular/build`, `@angular/cli`, `typescript` |