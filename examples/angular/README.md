# Example Embed App — Angular

Angular 19 (standalone + signals) demo for [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk).

```bash
npm install
npm run dev        # dev server on http://localhost:5176
npm run build      # production build → ./dist
```

Entry file: [`src/app/app.component.ts`](./src/app/app.component.ts) — single standalone component with signals, `OnPush`, and inline template.

App metadata & required scopes live in [`public/config.json`](./public/config.json).

## Identity (OIDC `idToken`)

The **Identity** panel calls `verifyIdentity()`, which forwards `sdk.idToken` to
the demo backend's `POST /api/auth/session`. The backend verifies the JWT
signature against the host JWKS and returns the **trusted** `userId` (`sub`).
`userContext` is UI-only — never trust it for auth. See the
[root README](../../README.md#authenticating-the-user-oidc-idtoken) and
[`examples/backend-node`](../backend-node).
