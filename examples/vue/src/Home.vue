<script setup lang="ts">
import { onMounted, ref } from "vue";
import { AWScope } from "@antarctic-wallet/aw-sdk";

interface AppConfig {
  id: string;
  name: string;
}

const appName = ref("Загрузка...");

onMounted(async () => {
  const config: AppConfig = await fetch("./config.json").then((r) => r.json());
  appName.value = config.name;
});

const scenarios = [
  { title: "Вход", scopes: [AWScope.USER_DATA], route: "/auth" },
  { title: "Донат", scopes: [AWScope.USER_DATA, AWScope.PAY], route: "/pay" },
  {
    title: "Покупка и возврат",
    scopes: [AWScope.USER_DATA, AWScope.PAY],
    route: "/pay-refund",
  },
];
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>{{ appName }}</h1>
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
