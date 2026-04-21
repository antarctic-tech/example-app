# Example Embed App — Vue

Vue 3 + Vite demo for [`@antarctic-wallet/aw-sdk`](https://www.npmjs.com/package/@antarctic-wallet/aw-sdk).

```bash
npm install
npm run dev        # dev server on http://localhost:5174
npm run build      # production build → ./dist
```

Entry file: [`src/App.vue`](./src/App.vue) — `<script setup lang="ts">` with SDK bootstrap, `<template>`, and scoped SCSS in one SFC.

App metadata & required scopes live in [`public/config.json`](./public/config.json).
