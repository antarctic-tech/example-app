<script setup lang="ts">
/**
 * Сценарий: только вход.
 *
 * 1. appId из public/config.json (поле id).
 * 2. Кнопка «Войти» → new AWSDK(...).init().
 * 3. userContext — для UI (имя, аватар). На бэкенд не отправляем.
 * 4. POST sdk.idToken на свой сервер → доверенный userId (sub).
 *
 * Скоупы заданы в этом файле, не в config.json.
 */
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { AWInitError, AWSDK, AWTimeoutError } from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

/** Скоупы этого сценария — только профиль. */
const SCOPES = ['userData'] as const;

type Status = 'idle' | 'connecting' | 'ready' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  idle: 'ожидание',
  connecting: 'подключение',
  ready: 'готово',
  error: 'ошибка',
};

/** Origin кошелька для канала postMessage. */
function getParentOrigin(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('parentOrigin');
  if (fromQuery) return fromQuery;
  if (window.parent !== window && document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      //
    }
  }
  return 'https://localhost:3310';
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const status = ref<Status>('idle');
const appName = ref('Загрузка...');
const user = ref<AWUserContext | null>(null);
const trustedUserId = ref<string | null>(null);
const message = ref('');
const loggingIn = ref(false);
const sdk = shallowRef<AWSDK | null>(null);

async function verifyIdentity(idToken: string) {
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = (await response.json()) as {
    ok?: boolean;
    userId?: string;
    error?: string;
    reason?: string;
    claim?: string;
    hint?: string;
  };
  if (!response.ok || !data.ok || !data.userId) {
    const parts = [data.error, data.reason, data.claim, data.hint].filter(Boolean);
    throw new Error(parts.join(' · ') || `HTTP ${response.status}`);
  }
  trustedUserId.value = data.userId;
}

/** Создаёт SDK и подписывается на события. init() — только по кнопке. */
async function prepareSdk() {
  const config: AppConfig = await fetch('./config.json').then((r) => r.json());
  appName.value = config.name;

  const instance = new AWSDK({
    appId: config.id,
    scopes: [...SCOPES],
    parentOrigin: getParentOrigin(),
    persistSession: true,
  });
  sdk.value = instance;

  instance.events.on('sdk.ready', (session: AWSession) => {
    status.value = 'ready';
    user.value = session.userContext ?? null;
    const idToken = instance.idToken ?? session.idToken;
    if (!idToken) {
      message.value = 'Нет idToken — дождитесь сессии и попробуйте снова.';
      return;
    }
    void verifyIdentity(idToken)
      .then(() => {
        message.value = 'Личность подтверждена на бэкенде.';
      })
      .catch((error: unknown) => {
        message.value = asErrorMessage(error);
      });
  });

  instance.events.on('sdk.error', ({ message: text }) => {
    status.value = 'error';
    message.value = text;
  });

  instance.events.on('session.expired', () => {
    status.value = 'error';
    user.value = null;
    trustedUserId.value = null;
    message.value = 'Сессия истекла — войдите снова.';
  });
}

async function login() {
  const instance = sdk.value;
  if (!instance || loggingIn.value) return;

  loggingIn.value = true;
  status.value = 'connecting';
  message.value = '';
  try {
    await instance.init();
  } catch (error) {
    status.value = 'error';
    if (error instanceof AWInitError || error instanceof AWTimeoutError) {
      message.value = asErrorMessage(error);
    } else {
      message.value = asErrorMessage(error);
    }
  } finally {
    loggingIn.value = false;
  }
}

onMounted(() => {
  void prepareSdk();
});

onUnmounted(() => {
  sdk.value?.destroy();
  sdk.value = null;
});
</script>

<template>
  <div class="app">
    <header class="header">
      <router-link class="back" to="/">← Все сценарии</router-link>
      <h1>{{ appName }} — Вход</h1>
      <span :class="['dot', `-${status}`]"></span>
      <span class="muted">{{ STATUS_LABEL[status] }}</span>
    </header>

    <section v-if="status !== 'ready'" class="card">
      <p class="hint">
        Нажмите кнопку, чтобы начать хендшейк с кошельком. В проде внутри
        кошелька <code>init()</code> можно вызывать при открытии экрана.
      </p>
      <button
        class="btn"
        type="button"
        :disabled="!sdk || loggingIn || status === 'connecting'"
        @click="login"
      >
        {{ loggingIn || status === 'connecting' ? 'Подключение…' : 'Войти через Antarctic Wallet' }}
      </button>
    </section>

    <section v-if="user" class="card">
      <div class="user">
        <img v-if="user.avatarUrl" :src="user.avatarUrl" alt="" />
        <div>
          <div class="name">{{ user.displayName ?? 'Пользователь' }}</div>
          <div v-if="user.walletAddress" class="muted">{{ user.walletAddress }}</div>
        </div>
      </div>
      <p class="hint">
        Профиль выше — из <code>userContext</code>, только для UI. Бэкенду ему
        нельзя доверять (IDOR).
      </p>
    </section>

    <section v-if="status === 'ready'" class="card">
      <div class="label">Доверенный userId</div>
      <div class="value">{{ trustedUserId ?? '—' }}</div>
      <p class="hint">
        Из <code>POST /api/auth/session</code> после проверки подписанного
        <code>idToken</code>.
      </p>
    </section>

    <p v-if="message" class="status">{{ message }}</p>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, system-ui, sans-serif;
  background: #0f1117;
  color: #e4e4e7;
}
.app { max-width: 420px; margin: 0 auto; padding: 20px; }
.header { margin-bottom: 16px; }
.back {
  display: inline-block;
  font-size: 12px;
  color: #818cf8;
  text-decoration: none;
  margin-bottom: 8px;
}
.header h1 { font-size: 18px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; display: inline-block; }
.dot.-connecting { background: #f59e0b; }
.dot.-ready { background: #10b981; }
.dot.-error { background: #ef4444; }
.muted { color: #a1a1aa; font-size: 12px; }
.card {
  background: #1a1b26;
  border: 1px solid #2a2b3d;
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 12px;
}
.user { display: flex; align-items: center; gap: 12px; }
.user img { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; }
.name { font-weight: 600; }
.label { font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: #a1a1aa; margin-bottom: 6px; }
.value { font-weight: 600; word-break: break-all; }
.hint { font-size: 12px; color: #71717a; line-height: 1.5; margin: 10px 0 0; }
.hint code { font-size: 11px; }
.status { font-size: 13px; color: #a1a1aa; }
.btn {
  width: 100%;
  padding: 10px 0;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #818cf8);
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
