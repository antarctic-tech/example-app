<script setup lang="ts">
/**
 * Сценарий: выбор скоупов, затем вход и оплата с возвратом.
 *
 * Чекбоксы по умолчанию пустые. «Войти» создаёт SDK с отмеченным набором:
 * скоупы хендшейка фиксируются в конструкторе. После входа новые скоупы
 * добираются интентом type: "scopes". Уже выданный скоуп снять нельзя:
 * удалить скоупы можно только удалением всего приложения.
 * receive — тип интента и не требует никакого скоупа.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import {
  AWInitError,
  AWOperationError,
  AWScope,
  AWScopeError,
  AWSDK,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const GRANTABLE_SCOPES = [AWScope.USER_DATA, AWScope.BALANCE, AWScope.PAY] as const;
const AMOUNT = '0.10';

type Status = 'idle' | 'connecting' | 'ready' | 'error';
type OrderStatus = 'unpaid' | 'paid' | 'refunded';
type GrantableScope = (typeof GRANTABLE_SCOPES)[number];

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

function normalizeGranted(scopes: string[]): string[] {
  return scopes.filter((scope) =>
    (GRANTABLE_SCOPES as readonly string[]).includes(scope),
  );
}

function formatMoney(amount: number, scale: number): string {
  const negative = amount < 0;
  const digits = String(Math.abs(Math.trunc(amount))).padStart(Math.max(scale, 0) + 1, '0');
  const body = scale <= 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${body}` : body;
}

function formatScopeData(data: unknown): string {
  if (!Array.isArray(data)) return JSON.stringify(data) ?? 'нет данных';
  const lines: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') return JSON.stringify(data) ?? 'нет данных';
    const row = item as Record<string, unknown>;
    const available = row.available as Record<string, unknown> | undefined;
    if (
      typeof row.asset !== 'string' ||
      !available ||
      typeof available.amount !== 'number' ||
      !Number.isInteger(available.amount) ||
      typeof available.scale !== 'number' ||
      !Number.isInteger(available.scale)
    ) {
      return JSON.stringify(data) ?? 'нет данных';
    }
    lines.push(`${row.asset} ${formatMoney(available.amount, available.scale)}`);
  }
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(data) ?? 'нет данных';
}

const status = ref<Status>('idle');
const appName = ref('Загрузка...');
const appId = ref<string | null>(null);
const user = ref<AWUserContext | null>(null);
const trustedUserId = ref<string | null>(null);
const message = ref('');
const loggingIn = ref(false);
const busy = ref(false);
const orderStatus = ref<OrderStatus | null>(null);
const granted = ref<string[]>([]);
const picked = ref<string[]>([]);
const balanceText = ref('');
const session = ref<AWSession | null>(null);
const sdk = shallowRef<AWSDK | null>(null);
const router = useRouter();

const pendingScopes = computed(() =>
  picked.value.filter((scope) => !granted.value.includes(scope)),
);
const payGranted = computed(() => granted.value.includes(AWScope.PAY));

function isGranted(scope: string): boolean {
  return granted.value.includes(scope);
}

function currentIdToken(): string | null {
  return sdk.value?.idToken ?? session.value?.idToken ?? null;
}

function toggleScope(scope: GrantableScope, checked: boolean) {
  if (isGranted(scope)) return;
  picked.value = checked
    ? [...picked.value, scope]
    : picked.value.filter((item) => item !== scope);
}

function onScopeChange(scope: GrantableScope, event: Event) {
  toggleScope(scope, (event.target as HTMLInputElement).checked);
}

function applyGranted(scopes: string[]) {
  const next = normalizeGranted(scopes);
  granted.value = next;
  picked.value = picked.value.filter((scope) => !next.includes(scope));
  if (next.includes(AWScope.BALANCE)) void loadBalance();
  else balanceText.value = '';
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

async function postIntent(
  body: Record<string, unknown>,
): Promise<{ operationId: string; status: string | null; failureReason: string | null }> {
  const idToken = currentIdToken();
  if (!idToken) throw new Error('Нет idToken — нельзя создать интент');
  const response = await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
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
  const intentStatus = typeof parsed.status === 'string' ? parsed.status : null;
  const failureReason =
    typeof parsed.failureReason === 'string' ? parsed.failureReason : null;
  return { operationId, status: intentStatus, failureReason };
}

async function loadBalance() {
  const instance = sdk.value;
  if (!instance) return;
  try {
    balanceText.value = formatScopeData(await instance.scopes.getData());
  } catch (error) {
    if (error instanceof AWScopeError) balanceText.value = asErrorMessage(error);
    else balanceText.value = asErrorMessage(error);
  }
}

async function refreshGranted() {
  const instance = sdk.value;
  if (!instance) return;
  applyGranted(await instance.scopes.getScopes());
}

async function updateScopes() {
  const instance = sdk.value;
  const scopes = pendingScopes.value;
  if (!instance || !currentIdToken() || scopes.length === 0) return;
  busy.value = true;
  message.value = 'Создаём scopes-интент…';
  try {
    const { operationId, status: intentStatus, failureReason } = await postIntent({
      type: 'scopes',
      scopes,
    });
    if (intentStatus === 'failed') {
      message.value = `Скоупы: ${failureReason ?? 'failed'}`;
      return;
    }
    if (intentStatus !== 'approved') {
      message.value = 'Подтвердите скоупы в кошельке…';
      await instance.operations.requestConfirmation(operationId);
    }
    await refreshGranted();
    message.value = 'Скоупы обновлены.';
  } catch (error) {
    if (error instanceof AWOperationError || error instanceof AWScopeError) {
      message.value = asErrorMessage(error);
    } else {
      message.value = asErrorMessage(error);
    }
  } finally {
    busy.value = false;
  }
}

async function pay() {
  const instance = sdk.value;
  if (!instance || !currentIdToken() || !payGranted.value) {
    message.value = payGranted.value
      ? 'Сначала войдите через кошелёк.'
      : 'Сначала включите pay и нажмите «Обновить».';
    return;
  }
  busy.value = true;
  message.value = 'Создаём pay-интент…';
  try {
    const { operationId, status: intentStatus, failureReason } = await postIntent({
      type: 'pay',
      amount: AMOUNT,
    });
    orderStatus.value = 'unpaid';
    if (intentStatus === 'failed') {
      message.value = `Оплата: ${failureReason ?? 'failed'}`;
      return;
    }
    if (intentStatus === 'approved') {
      orderStatus.value = 'paid';
      message.value = 'Оплачено. Можно вернуть.';
      return;
    }
    message.value = 'Подтвердите оплату в кошельке…';
    const result = await instance.operations.requestConfirmation(operationId);
    if (result.status !== 'confirmed') {
      message.value = `Оплата: ${result.status}`;
      return;
    }
    orderStatus.value = 'paid';
    message.value = 'Оплачено. Можно вернуть.';
  } catch (error) {
    if (error instanceof AWOperationError || error instanceof AWScopeError) {
      message.value = asErrorMessage(error);
    } else {
      message.value = asErrorMessage(error);
    }
  } finally {
    busy.value = false;
  }
}

async function receive() {
  if (!currentIdToken()) return;
  busy.value = true;
  message.value = 'Создаём receive-интент…';
  try {
    const { status: intentStatus, failureReason } = await postIntent({
      type: 'receive',
      amount: AMOUNT,
    });
    if (intentStatus !== 'approved') {
      message.value = `Возврат: ${failureReason ?? intentStatus ?? 'failed'}`;
      return;
    }
    orderStatus.value = 'refunded';
    message.value = 'Возвращено.';
  } catch (error) {
    if (error instanceof AWOperationError) message.value = asErrorMessage(error);
    else message.value = asErrorMessage(error);
  } finally {
    busy.value = false;
  }
}

async function loadConfig() {
  const config: AppConfig = await fetch('./config.json').then((r) => r.json());
  appName.value = config.name;
  appId.value = config.id;
}

function bindSdk(instance: AWSDK) {
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
    const grantedNow = normalizeGranted(s.grantedScopes ?? []);
    const stillPending = picked.value.some((scope) => !grantedNow.includes(scope));
    void verifyIdentity(idToken)
      .then(() => {
        message.value = stillPending
          ? 'Вход выполнен. Нажмите «Обновить», чтобы запросить новые скоупы.'
          : 'Вход выполнен.';
      })
      .catch((error: unknown) => {
        message.value = asErrorMessage(error);
      });
  });

  instance.events.on('scopes.granted', ({ scopes }) => {
    applyGranted(scopes);
  });

  instance.events.on('sdk.error', ({ message: text }) => {
    status.value = 'error';
    message.value = text;
  });

  instance.events.on('session.expired', () => {
    status.value = 'error';
    user.value = null;
    trustedUserId.value = null;
    picked.value = [...new Set([...picked.value, ...granted.value])];
    granted.value = [];
    balanceText.value = '';
    orderStatus.value = null;
    message.value = 'Сессия истекла — войдите снова.';
  });

  instance.events.on('operation.rejected', ({ reason }) => {
    message.value = `Отклонено: ${reason}`;
  });
}

async function login() {
  const id = appId.value;
  if (!id || loggingIn.value || status.value === 'ready') return;

  loggingIn.value = true;
  status.value = 'connecting';
  message.value = '';
  try {
    try {
      sdk.value?.backButton.hide();
    } catch {
      // канала ещё могло не быть
    }
    sdk.value?.destroy();
    const instance = new AWSDK({
      appId: id,
      scopes: [...picked.value],
      parentOrigin: getParentOrigin(),
      // Иначе восстановленная сессия проигнорирует отмеченный набор.
      persistSession: false,
    });
    sdk.value = instance;
    bindSdk(instance);
    const pending = instance.init();
    try {
      instance.backButton.show();
    } catch (error) {
      message.value = asErrorMessage(error);
    }
    await pending;
  } catch (error) {
    status.value = 'error';
    if (
      error instanceof AWInitError ||
      error instanceof AWTimeoutError ||
      error instanceof AWScopeError
    ) {
      message.value = asErrorMessage(error);
    } else {
      message.value = asErrorMessage(error);
    }
  } finally {
    loggingIn.value = false;
  }
}

onMounted(() => {
  void loadConfig();
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
      <h1>{{ appName }} — Скоупы</h1>
      <span :class="['dot', `-${status}`]"></span>
      <span class="muted">{{ STATUS_LABEL[status] }}</span>
    </header>

    <section class="card">
      <div class="label">Скоупы</div>
      <p class="hint">
        Отметьте нужные скоупы и нажмите «Войти». После входа новые отмечаются здесь
        и подключаются кнопкой «Обновить». Уже выданный скоуп снять нельзя: удалить
        скоупы можно только удалением всего приложения.
      </p>
      <label
        v-for="scope in GRANTABLE_SCOPES"
        :key="scope"
        :class="['scope', { '-active': isGranted(scope) }]"
      >
        <input
          type="checkbox"
          :checked="isGranted(scope) || picked.includes(scope)"
          :disabled="isGranted(scope) || busy || loggingIn"
          @change="onScopeChange(scope, $event)"
        />
        <span>
          <span class="scope-name">{{ scope }}</span>
          <span v-if="isGranted(scope)" class="scope-note">активен</span>
        </span>
      </label>
      <button
        class="btn"
        type="button"
        :disabled="status !== 'ready' || busy || pendingScopes.length === 0"
        @click="updateScopes"
      >
        {{ busy ? '…' : 'Обновить' }}
      </button>
    </section>

    <section v-if="status !== 'ready'" class="card">
      <div class="label">Вход</div>
      <p class="hint">Вход запросит скоупы, отмеченные выше.</p>
      <button
        class="btn"
        type="button"
        :disabled="!appId || loggingIn || status === 'connecting'"
        @click="login"
      >
        {{ loggingIn || status === 'connecting' ? 'Подключение…' : 'Войти через Antarctic Wallet' }}
      </button>
    </section>

    <section v-if="user" class="card">
      <div class="label">Авторизация</div>
      <div class="user">
        <img v-if="user.avatarUrl" :src="user.avatarUrl" alt="" />
        <div>
          <div class="name">{{ user.displayName ?? 'Пользователь' }}</div>
          <div class="muted">{{ trustedUserId ?? 'проверка…' }}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="label">Баланс</div>
      <p v-if="!isGranted(AWScope.BALANCE)" class="hint">
        Включите balance и нажмите «Обновить».
      </p>
      <p v-else class="value balance">{{ balanceText || 'загрузка…' }}</p>
    </section>

    <section class="card">
      <div class="label">Оплата и возврат</div>
      <div class="value">{{ AMOUNT }} USDT</div>
      <p class="hint">
        Оплата доступна после скоупа pay. Возврат — после оплаты, скоуп для него не нужен
        <template v-if="orderStatus"> — демо-статус <strong>{{ ORDER_LABEL[orderStatus] }}</strong></template>.
      </p>
      <button
        v-if="orderStatus !== 'paid' && orderStatus !== 'refunded'"
        class="btn"
        type="button"
        :disabled="status !== 'ready' || busy || !payGranted"
        @click="pay"
      >
        {{ busy ? '…' : 'Оплатить' }}
      </button>
      <button
        v-else-if="orderStatus === 'paid'"
        class="btn -ghost"
        type="button"
        :disabled="busy"
        @click="receive"
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
.balance { white-space: pre-wrap; font-size: 13px; }
.hint { font-size: 12px; color: #71717a; line-height: 1.5; margin: 0 0 12px; }
.status { font-size: 13px; color: #a1a1aa; }
.scope {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: 10px;
  border: 1px solid transparent;
}
.scope.-active {
  background: rgba(16, 185, 129, 0.12);
  border-color: #10b981;
}
.scope-name { font-size: 13px; font-weight: 600; }
.scope-note { display: block; font-size: 11px; color: #10b981; }
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
