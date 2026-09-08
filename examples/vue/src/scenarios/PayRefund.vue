<script setup lang="ts">
/**
 * Сценарий: покупка (pay) и возврат (receive).
 *
 * Заказ в проде — на вашем бэкенде. В демо статус только в UI.
 * Скоупы заданы в этом файле.
 */
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { AWInitError, AWSDK, AWTimeoutError } from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const SCOPES = ['userData', 'pay', 'receive'] as const;
const ITEM_AMOUNT = '9.00';

type Status = 'idle' | 'connecting' | 'ready' | 'error';
type OrderStatus = 'unpaid' | 'paid' | 'refunded';

const STATUS_LABEL: Record<Status, string> = {
  idle: 'ожидание',
  connecting: 'подключение',
  ready: 'готово',
  error: 'ошибка',
};

const ORDER_LABEL: Record<OrderStatus, string> = {
  unpaid: 'не оплачен',
  paid: 'оплачен',
  refunded: 'возвращён',
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
const orderStatus = ref<OrderStatus | null>(null);
const session = ref<AWSession | null>(null);
const sdk = shallowRef<AWSDK | null>(null);

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

async function createIntent(type: 'pay' | 'receive', amount: string): Promise<string> {
  const idToken = currentIdToken();
  if (!idToken) throw new Error('Нет idToken — нельзя создать интент');
  const response = await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, type, amount }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    //
  }
  if (!response.ok) {
    throw new Error((parsed.error as string | undefined) ?? `HTTP ${response.status}: ${text}`);
  }
  const operationId = readOperationId(parsed);
  if (!operationId) throw new Error(`В ответе нет operationId: ${text}`);
  return operationId;
}

async function buy() {
  const instance = sdk.value;
  if (!instance || !currentIdToken()) {
    message.value = 'Сначала войдите через кошелёк.';
    return;
  }
  busy.value = true;
  message.value = 'Создаём pay-интент…';
  try {
    const operationId = await createIntent('pay', ITEM_AMOUNT);
    orderStatus.value = 'unpaid';
    message.value = 'Подтвердите оплату в кошельке…';
    const result = await instance.operations.requestConfirmation(operationId);
    if (result.status !== 'confirmed') {
      message.value = `Оплата: ${result.status}`;
      return;
    }
    orderStatus.value = 'paid';
    message.value = 'Оплачено. Можно вернуть.';
  } catch (error) {
    message.value = asErrorMessage(error);
  } finally {
    busy.value = false;
  }
}

async function refund() {
  const instance = sdk.value;
  if (!instance || !currentIdToken()) return;
  busy.value = true;
  message.value = 'Создаём receive-интент…';
  try {
    const operationId = await createIntent('receive', ITEM_AMOUNT);
    message.value = 'Подтвердите возврат в кошельке…';
    const result = await instance.operations.requestConfirmation(operationId);
    if (result.status !== 'confirmed') {
      message.value = `Возврат: ${result.status}`;
      return;
    }
    orderStatus.value = 'refunded';
    message.value = 'Возвращено.';
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
        message.value = 'Вход выполнен. Купите демо-товар, затем верните его.';
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
      <h1>{{ appName }} — Покупка и возврат</h1>
      <span :class="['dot', `-${status}`]"></span>
      <span class="muted">{{ STATUS_LABEL[status] }}</span>
    </header>

    <section v-if="status !== 'ready'" class="card">
      <p class="hint">Сначала войдите через кошелёк, затем можно купить и вернуть товар.</p>
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
      <div class="label">Демо-товар</div>
      <div class="value">{{ ITEM_AMOUNT }} USDT</div>
      <p class="hint">
        В проде заказ хранится на вашем бэкенде
        <template v-if="orderStatus"> — демо-статус <strong>{{ ORDER_LABEL[orderStatus] }}</strong></template>.
      </p>
      <button
        v-if="orderStatus !== 'paid' && orderStatus !== 'refunded'"
        class="btn"
        type="button"
        :disabled="status !== 'ready' || busy"
        @click="buy"
      >
        {{ busy ? '…' : 'Купить' }}
      </button>
      <button
        v-else-if="orderStatus === 'paid'"
        class="btn -ghost"
        type="button"
        :disabled="busy"
        @click="refund"
      >
        {{ busy ? '…' : 'Вернуть' }}
      </button>
      <p v-else class="hint">Заказ возвращён.</p>
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
.value { font-weight: 600; margin-bottom: 8px; }
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
.btn.-ghost { background: #2a2b3d; color: #e4e4e7; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
