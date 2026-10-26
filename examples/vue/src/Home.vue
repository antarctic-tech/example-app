<script lang="ts">
/**
 * Параметр этого открытия iframe. Вне setup, иначе каждый заход на экран
 * начинал бы хендшейк заново. refreshSession() его не меняет.
 */
let cachedStartParam: string | null | undefined;
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import { AWScope, AWSDK } from "@antarctic-wallet/aw-sdk";

interface AppConfig {
  id: string;
  name: string;
}

function getParentOrigin(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("parentOrigin");
  if (fromQuery) return fromQuery;
  if (window.parent !== window && document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      //
    }
  }
  return "https://localhost:3310";
}

const appName = ref("Загрузка...");
const startParam = ref<string | null>(null);
const startParamReady = ref(false);
const sdk = shallowRef<AWSDK | null>(null);

let alive = true;

async function readStartParam(appId: string) {
  if (cachedStartParam !== undefined) {
    startParam.value = cachedStartParam;
    return;
  }
  if (!AWSDK.isInsideWallet()) {
    cachedStartParam = null;
    return;
  }

  const instance = new AWSDK({
    appId,
    scopes: [],
    parentOrigin: getParentOrigin(),
    persistSession: false,
  });
  if (!alive) {
    instance.destroy();
    return;
  }
  sdk.value = instance;

  instance.events.on("sdk.ready", () => {
    if (!alive) return;
    startParam.value = instance.startParam;
  });
  instance.events.on("sdk.error", () => {
    if (!alive) return;
    startParam.value = null;
  });

  await instance.init();
  if (!alive) return;
  cachedStartParam = instance.startParam;
  startParam.value = cachedStartParam;
}

onMounted(() => {
  void (async () => {
    try {
      const config: AppConfig = await fetch("./config.json").then((r) => r.json());
      if (!alive) return;
      appName.value = config.name;
      await readStartParam(config.id);
    } catch {
      if (alive) startParam.value = null;
    } finally {
      if (alive) startParamReady.value = true;
    }
  })();
});

onUnmounted(() => {
  alive = false;
  sdk.value?.destroy();
  sdk.value = null;
});

const scenarios = [
  { title: "Вход", scopes: [AWScope.USER_DATA], route: "/auth" },
  { title: "Донат", scopes: [AWScope.USER_DATA, AWScope.PAY], route: "/pay" },
  {
    title: "Покупка и возврат",
    scopes: [AWScope.USER_DATA, AWScope.PAY],
    route: "/pay-refund",
  },
  { title: "Открыть апку", scopes: [AWScope.USER_DATA], route: "/open-app" },
];
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>{{ appName }}</h1>
      <p class="start-param">
        start_param:
        <code :class="{ '-empty': !startParam }">{{ startParamReady ? (startParam ?? "—") : "…" }}</code>
      </p>
    </header>

    <article v-for="item in scenarios" :key="item.route" class="card">
      <h2>{{ item.title }}</h2>
      <p class="scopes">
        Скоупы: <code>{{ item.scopes.join(", ") }}</code>
      </p>
      <router-link class="btn" :to="item.route">Открыть</router-link>
    </article>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: Inter, system-ui, sans-serif;
  background: #0f1117;
  color: #e4e4e7;
}
.app {
  max-width: 420px;
  margin: 0 auto;
  padding: 20px;
}
.header {
  margin-bottom: 16px;
}
.header h1 {
  font-size: 20px;
  margin: 0;
}
.start-param {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 0;
  font-size: 12px;
  color: #71717a;
}
.start-param code {
  font-size: 12px;
  line-height: 1.4;
  font-weight: 600;
  color: #c7d2fe;
  background: #1a1b26;
  border: 1px solid #2a2b3d;
  border-radius: 8px;
  padding: 2px 8px;
  word-break: break-all;
}
.start-param code.-empty {
  color: #71717a;
  font-weight: 500;
}
.card {
  background: #1a1b26;
  border: 1px solid #2a2b3d;
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 12px;
}
.card h2 {
  font-size: 16px;
  margin: 0 0 8px;
}
.scopes {
  font-size: 12px;
  color: #71717a;
  margin: 0 0 12px;
}
code {
  font-size: 11px;
}
.btn {
  display: block;
  width: 100%;
  padding: 10px 0;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #818cf8);
}
</style>
