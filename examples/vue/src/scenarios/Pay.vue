<script setup lang="ts">
/**
 * Сценарий: вход + односторонний платёж (донат).
 *
 * После входа ваш бэкенд создаёт интент pay через POST /api/intents.
 * Возврата нет. Скоупы заданы в этом файле.
 */
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { AWInitError, AWScope, AWSDK, AWTimeoutError } from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const SCOPES = [AWScope.USER_DATA, AWScope.PAY] as const;
const DONATE_AMOUNT = '1.00';

type Status = 'idle' | 'connecting' | 'ready' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  idle: 'ожидание',
  connecting: 'подключение',
  ready: 'готово',
  error: 'ошибка',
};

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

function readOperationId(payload: Record<string, unknown>): string | null {
  const nested = payload.data as Record<string, unknown> | undefined;
  const id =
    nested?.operationId ??
    nested?.operation_id ??
    payload.operationId ??
    payload.operation_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

const status = ref<Status>('idle');
const appName = ref('Загрузка...');
const user = ref<AWUserContext | null>(null);
const trustedUserId = ref<string | null>(null);
const message = ref('');
const loggingIn = ref(false);
const busy = ref(false);
const session = ref<AWSession | null>(null);
const sdk = shallowRef<AWSDK | null>(null);
const router = useRouter();

function currentIdToken(): string | null {
  return sdk.value?.idToken ?? session.value?.idToken ?? null;
}

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
  };
  if (!response.ok || !data.ok || !data.userId) {
    throw new Error(data.reason ?? data.error ?? `HTTP ${response.status}`);
  }
  trustedUserId.value = data.userId;
}

async function createPayIntent(amount: string): Promise<{
  operationId: string;
  status: string | null;
  failureReason: string | null;
}> {
  const idToken = currentIdToken();
  if (!idToken) throw new Error('Нет idToken — нельзя создать интент');
  const response = await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, type: 'pay', amount }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    //
  }
  if (!response.ok) {
    throw new Error(
      (parsed.error as string | undefined) ?? `HTTP ${response.status}: ${text}`,
    );
  }
  const operationId = readOperationId(parsed);
  if (!operationId) throw new Error(`В ответе нет operationId: ${text}`);
  const status = typeof parsed.status === 'string' ? parsed.status : null;
  const failureReason =
    typeof parsed.failureReason === 'string' ? parsed.failureReason : null;
  return { operationId, status, failureReason };
}

async function donate() {
  const instance = sdk.value;
  if (!instance || !currentIdToken()) {
    message.value = 'Сначала войдите через кошелёк.';
    return;
  }
  busy.value = true;
  message.value = 'Создаём pay-интент…';
  try {
    const { operationId, status: intentStatus, failureReason } =
      await createPayIntent(DONATE_AMOUNT);
    if (intentStatus === 'failed') {
      message.value = `Донат: ${failureReason ?? 'failed'}`;
      return;
    }
    if (intentStatus === 'approved') {
      message.value = 'Донат: approved';
      return;
    }
    message.value = 'Подтвердите в кошельке…';
    const result = await instance.operations.requestConfirmation(operationId);
    message.value = `Донат: ${result.status}${result.txId ? ` · ${result.txId}` : ''}`;
  } catch (error) {
    message.value = asErrorMessage(error);
  } finally {
    busy.value = false;
  }
}

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

  instance.backButton.onClick(() => {
    void router.push('/');
  });

  instance.events.on('sdk.ready', (s: AWSession) => {
    status.value = 'ready';
    session.value = s;
    user.value = s.userContext ?? null;
    const idToken = instance.idToken ?? s.idToken;
    if (!idToken) {
      message.value = 'Нет idToken.';
      return;
    }
    void verifyIdentity(idToken)
      .then(() => {
        message.value = 'Вход выполнен. Можно отправить донат.';
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

  instance.events.on('operation.rejected', ({ reason }) => {
    message.value = `Отклонено: ${reason}`;
  });

  void login();
}

async function login() {
  const instance = sdk.value;
  if (!instance || loggingIn.value) return;

  loggingIn.value = true;
  status.value = 'connecting';
  message.value = '';
  try {
    const pending = instance.init();
    try {
      instance.backButton.show();
    } catch (error) {
      message.value = asErrorMessage(error);
    }
    await pending;
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
  try {
    sdk.value?.backButton.hide();
  } catch {
    // хост мог уже закрыть канал
  }
  sdk.value?.destroy();
  sdk.value = null;
});
</script>

<template>
  <div class="app">
    <header class="header">
      <router-link class="back" to="/">← Все сценарии</router-link>
      <h1>{{ appName }} — Донат</h1>
      <span :class="['dot', `-${status}`]"></span>
      <span class="muted">{{ STATUS_LABEL[status] }}</span>
    </header>

    <section v-if="status !== 'ready'" class="card">
      <p class="hint">Сначала войдите через кошелёк, затем можно отправить донат.</p>
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
          <div class="muted">{{ trustedUserId ?? 'проверка…' }}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="label">Односторонний платёж</div>
      <p class="hint">
        Отправляет {{ DONATE_AMOUNT }} USDT. Без возврата — как донат.
      </p>
      <button
        class="btn"
        type="button"
        :disabled="status !== 'ready' || busy"
        @click="donate"
      >
        {{ busy ? '…' : `Пожертвовать ${DONATE_AMOUNT} USDT` }}
      </button>
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
.header h1 { font-size: 18px; margin: 0 0 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; display: inline-block; }
.dot.-connecting { background: #f59e0b; }
.dot.-ready { background: #10b981; }
.dot.-error { background: #ef4444; }
.muted { color: #a1a1aa; font-size: 12px; word-break: break-all; }
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
.hint { font-size: 12px; color: #71717a; line-height: 1.5; margin: 0 0 12px; }
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
