<script setup lang="ts">
/**
 * Example DApp (Vue 3) — demo integration with the Antarctic Wallet SDK.
 *
 * The entire flow lives in one SFC: types → helpers → SDK init → operations → UI.
 * Standalone run: http://localhost:5174
 * When embedded: the wallet loads this app inside an iframe and passes its
 * origin via the ?parentOrigin=... query parameter.
 */
import { ref, shallowRef, onMounted, onUnmounted, nextTick, computed, watch } from 'vue';
import {
  AWSDK,
  AWInitError,
  AWOperationError,
  AWScopeError,
  AWSessionError,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

// ── Types ─────────────────────────────────────────────────────────────────

/** App configuration loaded from public/config.json */
interface AppConfig {
  id: string;
  name: string;
  requiredScopes: string[];
}

/** localStorage key for the user-supplied appId override */
const APP_ID_STORAGE_KEY = 'aw-demo:appId';

/**
 * Resolves the appId at startup. Priority:
 *   1. ?appId=... query parameter (one-shot override, also persisted)
 *   2. localStorage (previously entered by the user)
 *   3. null — UI will prompt the user to enter one
 */
function resolveStoredAppId(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('appId');
  if (fromQuery) {
    try {
      localStorage.setItem(APP_ID_STORAGE_KEY, fromQuery);
    } catch {
      //
    }
    return fromQuery;
  }
  try {
    return localStorage.getItem(APP_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Single Event Log entry — renders in the log panel in real time */
interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

/** SDK lifecycle: idle → connecting → ready (or error) */
type AppStatus = 'idle' | 'connecting' | 'ready' | 'error';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolves the parent window (wallet) origin for the postMessage channel.
 * Resolution order:
 *   1. ?parentOrigin=... — explicit override via query
 *   2. document.referrer — auto-detected when running inside an iframe
 *   3. localhost wallet dev-server fallback
 */
function getParentOrigin(): string {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('parentOrigin');
  if (fromParam) return fromParam;
  if (window.parent !== window && document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      //
    }
  }
  return 'https://localhost:3310';
}

/**
 * Normalises any SDK error into a human-readable string for the log.
 * Demonstrates how to work with every typed SDK error class.
 */
function handleSdkError(error: unknown): string {
  if (error instanceof AWOperationError) {
    return `Operation error [${error.errorCode}]: ${error.message} (opId: ${error.operationId})`;
  }
  if (error instanceof AWInitError) return `Init error [${error.errorCode}]: ${error.message}`;
  if (error instanceof AWSessionError) return `Session error [${error.errorCode}]: ${error.message}`;
  if (error instanceof AWScopeError) return `Scope error [${error.errorCode}]: ${error.message}`;
  if (error instanceof AWTimeoutError) return `Timeout: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Backend (B2B) intent demo helpers ─────────────────────────────────────
//
// IMPORTANT: real DApps MUST sign and POST these requests from THEIR server.
// API key/secret here is exposed in the browser ONLY because this is a demo
// to show wallet integrators what payload and signature the backend expects.
// Do NOT replicate this pattern in production — leaking api_secret in the
// browser allows anyone to impersonate the app.

interface BackendIntentConfig {
  apiBase: string;
  apiKey: string;
  apiSecret: string;
  bearerToken: string;
  telegramUserId: string;
}

/** Pending intent shape returned by GET /api/v2/sdk/operations/intents */
interface PendingIntent {
  operationId: string;
  type: string;
  status: string;
  data?: { amount?: string; scopes?: string[] } & Record<string, unknown>;
  approvedAt?: string | null;
}

const BACKEND_CONFIG_STORAGE_KEY = 'aw-demo:backendIntent:v2';
const LEGACY_BACKEND_CONFIG_STORAGE_KEY = 'aw-demo:backendIntent';

function loadBackendConfig(): BackendIntentConfig {
  try {
    localStorage.removeItem(LEGACY_BACKEND_CONFIG_STORAGE_KEY);
  } catch {
    //
  }
  try {
    const raw = localStorage.getItem(BACKEND_CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BackendIntentConfig>;
      return {
        apiBase: parsed.apiBase ?? '',
        apiKey: parsed.apiKey ?? '',
        apiSecret: parsed.apiSecret ?? '',
        bearerToken: parsed.bearerToken ?? '',
        telegramUserId: parsed.telegramUserId ?? '',
      };
    }
  } catch {
    //
  }
  return { apiBase: '', apiKey: '', apiSecret: '', bearerToken: '', telegramUserId: '' };
}

function saveBackendConfig(cfg: BackendIntentConfig): void {
  try {
    localStorage.setItem(BACKEND_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    //
  }
}

interface BackendIntentResponse {
  data?: { operationId?: string; operation_id?: string };
  operationId?: string;
  operation_id?: string;
}

interface IntentRelayPayload {
  apiBase: string;
  apiKey: string;
  apiSecret: string;
  type: 'pay' | 'receive';
  telegramUserId: number;
  amount: string;
}

/**
 * Posts the intent payload to OUR backend (`/api/intents`). The backend signs
 * the HMAC and forwards to AW. The browser never has to compute the HMAC, but
 * for this demo we still ship `apiSecret` in the body — clearly NOT how a
 * real integration should work.
 */
async function createBackendIntent(
  payload: IntentRelayPayload,
): Promise<{ operationId: string; status: number; rawResponse: string }> {
  const response = await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  let parsed: BackendIntentResponse = {};
  try {
    parsed = JSON.parse(text) as BackendIntentResponse;
  } catch {
    //
  }
  const operationId =
    parsed.data?.operationId ??
    parsed.data?.operation_id ??
    parsed.operationId ??
    parsed.operation_id;
  if (!operationId) throw new Error(`No operationId in response: ${text}`);
  return { operationId, status: response.status, rawResponse: text };
}

// ── State ─────────────────────────────────────────────────────────────────

const config = ref<AppConfig | null>(null);
const status = ref<AppStatus>('idle');
const session = ref<AWSession | null>(null);
const user = ref<AWUserContext | null>(null);
const insideWallet = ref(false);
const logs = ref<LogEntry[]>([]);
const busy = ref<string | null>(null);
const logContainer = ref<HTMLElement | null>(null);
const appId = ref<string | null>(resolveStoredAppId());
const appIdInput = ref('');
const backendCfg = ref<BackendIntentConfig>(loadBackendConfig());
const intentType = ref<'pay' | 'receive'>('pay');
const intentAmount = ref('5.00');
const pendingIntents = ref<PendingIntent[]>([]);

const sdk = shallowRef<AWSDK | null>(null);
const disabled = computed(() => !session.value);

function addLog(message: string, type: LogEntry['type'] = 'info') {
  logs.value.push({ time: new Date().toLocaleTimeString(), message, type });
  nextTick(() => {
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight;
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Full SDK bootstrap — runs once on mount:
 *   1. Detect whether we're embedded inside the wallet (isInsideWallet)
 *   2. Load public/config.json with appId and requiredScopes
 *   3. Create the AWSDK instance with debug/retry/persistSession
 *   4. Subscribe to every SDK event (ready/error/scopes/session/operation)
 *   5. sdk.init() — handshake with the host over postMessage
 */
async function bootstrap(currentAppId: string) {
  insideWallet.value = AWSDK.isInsideWallet();
  addLog(`isInsideWallet: ${insideWallet.value}`);

  const cfg: AppConfig = await fetch('./config.json').then((r) => r.json());
  config.value = cfg;

  const instance = new AWSDK({
    appId: currentAppId,
    scopes: [...cfg.requiredScopes],
    parentOrigin: getParentOrigin(),
    debug: true,
    timeout: 30_000,
    persistSession: true,
    retry: { maxAttempts: 3, baseDelay: 1000 },
  });
  sdk.value = instance;

  // Handshake finished — session token and userContext are available
  instance.events.on('sdk.ready', (s: AWSession) => {
    addLog('SDK ready!', 'success');
    status.value = 'ready';
    session.value = s;
    user.value = s.userContext ?? null;
  });

  // Fatal SDK error (init failed, host unreachable, etc.)
  instance.events.on('sdk.error', ({ code, message }) => {
    addLog(`SDK error: [${code}] ${message}`, 'error');
    status.value = 'error';
  });

  // User approved additional scopes
  instance.events.on('scopes.granted', ({ scopes }) =>
    addLog(`Scopes granted: ${scopes.join(', ')}`, 'success'),
  );

  // Session token rotated (auto-refresh or explicit refreshSession())
  instance.events.on('session.refreshed', ({ sessionToken, expiresAt }) => {
    addLog(`Session refreshed, expires: ${new Date(expiresAt).toLocaleTimeString()}`);
    if (session.value) session.value = { ...session.value, sessionToken, expiresAt };
  });

  // Session expired — re-initialisation is required
  instance.events.on('session.expired', () => {
    addLog('Session expired!', 'warn');
    status.value = 'error';
    session.value = null;
    user.value = null;
  });

  // User declined to confirm the operation in the wallet UI
  instance.events.on('operation.rejected', ({ operationId, reason }) =>
    addLog(`Operation ${operationId} rejected: ${reason}`, 'warn'),
  );

  addLog('Initializing SDK...');
  status.value = 'connecting';
  try {
    await instance.init();
  } catch (error) {
    addLog(`Init failed: ${handleSdkError(error)}`, 'error');
    status.value = 'error';
  }
}

onMounted(() => {
  insideWallet.value = AWSDK.isInsideWallet();
  if (!appId.value) {
    addLog('Waiting for appId...', 'warn');
    return;
  }
  bootstrap(appId.value);
});

let intentsPollId: number | null = null;

onUnmounted(() => {
  sdk.value?.destroy();
  sdk.value = null;
  if (intentsPollId !== null) {
    window.clearInterval(intentsPollId);
    intentsPollId = null;
  }
});

/**
 * Auto-refresh the pending intents list every 5 seconds whenever the user
 * has filled in both the API base URL and the bearer token.
 */
watch(
  () => [backendCfg.value.apiBase, backendCfg.value.bearerToken] as const,
  ([apiBase, bearer]) => {
    if (intentsPollId !== null) {
      window.clearInterval(intentsPollId);
      intentsPollId = null;
    }
    if (!apiBase || !bearer) return;
    fetchPendingIntents();
    intentsPollId = window.setInterval(fetchPendingIntents, 5000);
  },
  { immediate: true, deep: true },
);

/** Persist user-supplied appId and trigger SDK bootstrap */
function submitAppId() {
  const trimmed = appIdInput.value.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(APP_ID_STORAGE_KEY, trimmed);
  } catch {
    //
  }
  appId.value = trimmed;
  bootstrap(trimmed);
}

/** Clear stored appId and reset SDK so the user can enter a new one */
function changeAppId() {
  try {
    localStorage.removeItem(APP_ID_STORAGE_KEY);
  } catch {
    //
  }
  sdk.value?.destroy();
  sdk.value = null;
  appId.value = null;
  appIdInput.value = '';
  config.value = null;
  session.value = null;
  user.value = null;
  status.value = 'idle';
  logs.value = [];
}

// ── Actions ───────────────────────────────────────────────────────────────

/** Force-rotate the session token ahead of its expiry */
async function refresh() {
  if (!sdk.value) return;
  busy.value = 'refresh';
  try {
    await sdk.value.refreshSession();
    addLog('Session refreshed successfully', 'success');
  } catch (error) {
    addLog(`Refresh failed: ${handleSdkError(error)}`, 'error');
  } finally {
    busy.value = null;
  }
}

/** Query the wallet for authoritative session status and granted scopes */
async function checkStatus() {
  if (!sdk.value) return;
  busy.value = 'status';
  try {
    const r = await sdk.value.status();
    addLog(
      `Status: ${r.status}, expires: ${new Date(r.expiresAt).toLocaleTimeString()}, scopes: [${r.grantedScopes.join(', ')}]`,
      'success',
    );
  } catch (error) {
    addLog(`Status check failed: ${handleSdkError(error)}`, 'error');
  } finally {
    busy.value = null;
  }
}

/**
 * DEMO ONLY — backend-to-backend intent flow run from the browser.
 *
 * Real apps must perform this request from their server because it requires
 * the app's api_secret to sign the HMAC. Here we sign in the browser purely
 * to demonstrate the request/response shape to integrators.
 */
async function runBackendIntent() {
  const cfg = backendCfg.value;
  if (!cfg.apiBase || !cfg.apiKey || !cfg.apiSecret || !cfg.telegramUserId) {
    addLog('Backend intent demo: fill apiBase, apiKey, apiSecret, telegramUserId first', 'warn');
    return;
  }
  const telegramUserIdNum = Number(cfg.telegramUserId);
  if (!Number.isFinite(telegramUserIdNum) || !Number.isInteger(telegramUserIdNum)) {
    addLog('Backend intent demo: telegramUserId must be an integer', 'warn');
    return;
  }
  const payload: IntentRelayPayload = {
    apiBase: cfg.apiBase,
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    type: intentType.value,
    telegramUserId: telegramUserIdNum,
    amount: intentAmount.value,
  };
  busy.value = 'b2b';
  addLog(`[B2B ${intentType.value}] POST /api/intents (relayed to ${cfg.apiBase})`);
  try {
    const { operationId, status, rawResponse } = await createBackendIntent(payload);
    addLog(`[B2B ${intentType.value}] HTTP ${status} → ${rawResponse.slice(0, 200)}`, 'success');
    addLog(
      `[B2B ${intentType.value}] operationId: ${operationId}. Wait for the wallet shell + webhook to deliver the result.`,
      'success',
    );
  } catch (error) {
    addLog(`[B2B ${intentType.value}] failed: ${handleSdkError(error)}`, 'error');
  } finally {
    busy.value = null;
  }
}

/**
 * GET /api/v2/sdk/operations/intents — lists pending intents for the current
 * user. Requires the user's `Authorization: Bearer <jwt>` token.
 */
async function fetchPendingIntents() {
  const cfg = backendCfg.value;
  if (!cfg.apiBase) {
    addLog('Backend intent list: fill API Base URL first', 'warn');
    return;
  }
  if (!cfg.bearerToken) {
    addLog('Backend intent list: fill Bearer Token first', 'warn');
    return;
  }
  busy.value = 'intents';
  const url = `${cfg.apiBase.replace(/\/$/, '')}/api/v2/sdk/operations/intents`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.bearerToken}`,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    const parsed = JSON.parse(text) as { data?: PendingIntent[] };
    const list = Array.isArray(parsed.data) ? parsed.data : [];
    pendingIntents.value = list;
  } catch (error) {
    addLog(`[Intents] failed: ${handleSdkError(error)}`, 'error');
  } finally {
    busy.value = null;
  }
}

/** Open wallet's approve/reject sheet for the chosen intent */
async function approveIntent(intent: PendingIntent) {
  if (!sdk.value) {
    addLog('SDK not ready', 'warn');
    return;
  }
  addLog(`[Intents] requesting confirmation for ${intent.operationId}...`);
  try {
    const result = await sdk.value.operations.requestConfirmation(intent.operationId);
    addLog(
      `[Intents] ${intent.operationId} → ${result.status}${result.txId ? `, txId: ${result.txId}` : ''}`,
      'success',
    );
    void fetchPendingIntents();
  } catch (error) {
    addLog(`[Intents] confirmation failed: ${handleSdkError(error)}`, 'error');
  }
}

function persistBackendCfg() {
  saveBackendConfig(backendCfg.value);
}

</script>

<template>
  <div v-if="!appId" class="app">
    <header class="header">
      <h1 class="header__title">Example DApp</h1>
      <div class="header__badges">
        <span :class="insideWallet ? 'badge -inside' : 'badge -outside'">
          {{ insideWallet ? 'In Wallet' : 'Standalone' }}
        </span>
      </div>
    </header>
    <section class="panel">
      <div class="panel__title">Enter App ID</div>
      <form @submit.prevent="submitAppId">
        <input
          v-model="appIdInput"
          class="input"
          type="text"
          placeholder="e.g. dev1"
          autofocus
        />
        <button class="btn -accent" type="submit" :disabled="!appIdInput.trim()">
          Continue
        </button>
      </form>
    </section>
  </div>

  <div v-else class="app">
    <header class="header">
      <h1 class="header__title">{{ config?.name ?? 'Loading...' }}</h1>
      <div class="header__badges">
        <span :class="insideWallet ? 'badge -inside' : 'badge -outside'">
          {{ insideWallet ? 'In Wallet' : 'Standalone' }}
        </span>
        <span :class="`status-dot -${status}`"></span>
        <span class="status-label">{{ status }}</span>
        <span class="app-id">appId: {{ appId }}</span>
        <button class="btn-link" type="button" @click="changeAppId">Change</button>
      </div>
    </header>

    <section v-if="user" class="panel">
      <div class="user">
        <img v-if="user.avatarUrl" :src="user.avatarUrl" alt="" class="user__avatar" />
        <div>
          <div v-if="user.displayName" class="user__name">{{ user.displayName }}</div>
          <div v-if="user.walletAddress" class="user__wallet">{{ user.walletAddress }}</div>
          <div v-if="user.userId" class="user__id">ID: {{ user.userId }}</div>
        </div>
      </div>
    </section>

    <section v-if="session" class="panel">
      <div class="panel__title">Session</div>
      <div class="info-grid">
        <span class="info-grid__label">Token</span>
        <span class="info-grid__value">{{ session.sessionToken.slice(0, 20) }}...</span>
        <span class="info-grid__label">Expires</span>
        <span class="info-grid__value">{{ new Date(session.expiresAt).toLocaleTimeString() }}</span>
      </div>
      <div class="scopes">
        <span v-for="s in session.grantedScopes" :key="s" class="scope-chip">{{ s }}</span>
      </div>
    </section>

    <div class="actions-grid">
      <section class="panel">
        <div class="panel__title">Session</div>
        <button class="btn -ghost" :disabled="disabled || busy === 'refresh'" @click="refresh">
          Refresh
        </button>
        <button class="btn -ghost" :disabled="disabled || busy === 'status'" @click="checkStatus">
          Check Status
        </button>
      </section>
    </div>

    <section class="panel">
      <div class="panel__title">Backend Intent (DEMO ONLY)</div>
      <div class="warn-box">
        ⚠️ TESTING ONLY. Real apps NEVER send <code>apiSecret</code> from
        the browser — the secret stays on YOUR server. Here we relay through
        our demo backend (<code>/api/intents</code>) just to make the flow
        observable end-to-end.
      </div>
      <label class="field-label">API Base URL</label>
      <input
        class="input"
        type="text"
        placeholder="auto-derived from wallet origin"
        v-model="backendCfg.apiBase"
        @blur="persistBackendCfg"
      />
      <label class="field-label">API Key</label>
      <input
        class="input"
        type="text"
        placeholder="X-Sdk-App-Key"
        v-model="backendCfg.apiKey"
        @blur="persistBackendCfg"
      />
      <label class="field-label">API Secret</label>
      <input
        class="input"
        type="password"
        placeholder="HMAC secret"
        v-model="backendCfg.apiSecret"
        @blur="persistBackendCfg"
      />
      <label class="field-label">Bearer Token (for intents list)</label>
      <input
        class="input"
        type="password"
        placeholder="user JWT for Authorization header"
        v-model="backendCfg.bearerToken"
        @blur="persistBackendCfg"
      />
      <label class="field-label">Telegram User ID</label>
      <input
        class="input"
        type="text"
        placeholder="target user telegram id"
        v-model="backendCfg.telegramUserId"
        @blur="persistBackendCfg"
      />
      <label class="field-label">Intent Type</label>
      <select class="input" v-model="intentType">
        <option value="pay">pay</option>
        <option value="receive">receive</option>
      </select>
      <label class="field-label">Amount (USDT)</label>
      <input class="input" type="text" placeholder="5.00" v-model="intentAmount" />
      <button class="btn -accent" :disabled="busy === 'b2b'" @click="runBackendIntent">
        {{ busy === 'b2b' ? '...' : `Send ${intentType} intent` }}
      </button>
    </section>

    <section class="panel">
      <div class="panel__title">Pending Intents</div>
      <button class="btn -ghost" :disabled="busy === 'intents'" @click="fetchPendingIntents">
        {{ busy === 'intents' ? '...' : 'Refresh List' }}
      </button>
      <div v-if="pendingIntents.length === 0" class="hint">No intents loaded.</div>
      <ul v-else class="intent-list">
        <li v-for="it in pendingIntents" :key="it.operationId">
          <button
            class="intent-item"
            type="button"
            @click="approveIntent(it)"
            title="Open wallet sheet to approve or reject"
          >
            <span class="intent-item__type">{{ it.type }}</span>
            <span class="intent-item__id">
              {{ it.data?.amount
                ? `${it.data.amount} USDT`
                : it.data?.scopes?.length
                  ? it.data.scopes.join(', ')
                  : `${it.operationId.slice(0, 8)}…` }}
            </span>
            <span class="intent-item__status">{{ it.status }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section class="panel">
      <div class="panel__title">Event Log</div>
      <div ref="logContainer" class="log">
        <div v-for="(e, i) in logs" :key="i" :class="`log__line -${e.type}`">
          <span class="log__time">[{{ e.time }}]</span> {{ e.message }}
        </div>
      </div>
    </section>
  </div>
</template>

<style lang="scss">
$bg-base: #0f1117;
$bg-surface: #1a1b26;
$border: #2a2b3d;
$text-primary: #e4e4e7;
$text-secondary: #a1a1aa;
$text-muted: #71717a;
$text-dim: #52525b;
$accent: #6366f1;
$accent-bright: #818cf8;

$status: (
  idle: #6b7280,
  connecting: #f59e0b,
  ready: #10b981,
  error: #ef4444,
);

$log-colors: (
  info: #60a5fa,
  success: #34d399,
  error: #f87171,
  warn: #fbbf24,
);

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: $bg-base;
  color: $text-primary;
}
</style>

<style scoped lang="scss">
$bg-base: #0f1117;
$bg-surface: #1a1b26;
$border: #2a2b3d;
$text-primary: #e4e4e7;
$text-secondary: #a1a1aa;
$text-muted: #71717a;
$text-dim: #52525b;
$accent: #6366f1;
$accent-bright: #818cf8;

$status-colors: (
  idle: #6b7280,
  connecting: #f59e0b,
  ready: #10b981,
  error: #ef4444,
);

$log-colors: (
  info: #60a5fa,
  success: #34d399,
  error: #f87171,
  warn: #fbbf24,
);

/**
 * Root container
 */
.app {
  min-height: 100vh;
  padding: 20px;
  max-width: 480px;
  margin: 0 auto;
}

/**
 * Header with app title and status badges
 */
.header {
  margin-bottom: 20px;

  &__title {
    font-size: 22px;
    font-weight: 700;
    margin: 0;
    background: linear-gradient(135deg, $accent-bright, $accent);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    color: transparent;
  }

  &__badges {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
}

/**
 * Environment badge (standalone / in-wallet)
 */
.badge {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;

  &.-inside {
    background: rgba(16, 185, 129, 0.15);
    color: #34d399;
  }

  &.-outside {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
  }
}

/**
 * SDK status indicator dot
 */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 4px;

  @each $name, $color in $status-colors {
    &.-#{$name} {
      background: $color;
    }
  }
}

.status-label {
  font-size: 12px;
  color: $text-secondary;
}

/**
 * Content card
 */
.panel {
  background: $bg-surface;
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 12px;
  border: 1px solid $border;

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 12px;
  }
}

/**
 * User profile row
 */
.user {
  display: flex;
  align-items: center;
  gap: 12px;

  &__avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid $accent;
  }

  &__name { font-size: 15px; font-weight: 600; }
  &__wallet { font-size: 12px; color: $text-muted; word-break: break-all; }
  &__id { font-size: 11px; color: $text-dim; }
}

/**
 * Label/value info grid
 */
.info-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 13px;
  margin-bottom: 10px;

  &__label { color: $text-muted; }

  &__value {
    color: $text-primary;
    font-weight: 500;
    text-align: right;
    word-break: break-all;
  }
}

/**
 * List of granted scope chips
 */
.scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.scope-chip {
  background: rgba(99, 102, 241, 0.15);
  color: $accent-bright;
  padding: 3px 10px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
}

/**
 * Action-buttons grid
 */
.actions-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/**
 * Button
 */
.btn {
  width: 100%;
  padding: 10px 0;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: 6px;
  transition: opacity 0.15s;
  color: inherit;
  font-family: inherit;

  &:last-child { margin-bottom: 0; }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &.-accent {
    background: linear-gradient(135deg, $accent, $accent-bright);
    color: #fff;
  }

  &.-ghost {
    background: $border;
    color: $text-primary;
  }
}

/**
 * AppId input field
 */
.input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid $border;
  background: $bg-base;
  color: $text-primary;
  font-size: 14px;
  font-family: inherit;
  margin-bottom: 10px;
  outline: none;

  &:focus {
    border-color: $accent;
  }
}

.app-id {
  font-size: 11px;
  color: $text-secondary;
  font-family: 'JetBrains Mono', 'Menlo', monospace;
  margin-left: 4px;
}

.btn-link {
  background: none;
  border: none;
  color: $accent-bright;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  font-family: inherit;

  &:hover {
    text-decoration: underline;
  }
}

/**
 * Backend-intent demo panel
 */
.warn-box {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #fbbf24;
  font-size: 11px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: 8px;
  margin-bottom: 12px;

  code {
    background: rgba(245, 158, 11, 0.18);
    padding: 0 4px;
    border-radius: 3px;
    font-family: 'JetBrains Mono', 'Menlo', monospace;
  }
}

.field-label {
  display: block;
  font-size: 11px;
  color: $text-secondary;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.hint {
  font-size: 12px;
  color: $text-muted;
  margin-top: 8px;
}

.intent-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.intent-item {
  width: 100%;
  display: grid;
  grid-template-columns: 70px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid $border;
  border-radius: 8px;
  background: $bg-base;
  color: $text-primary;
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;

  &:hover {
    border-color: $accent;
    background: rgba(99, 102, 241, 0.08);
  }

  &__type {
    font-weight: 600;
    color: $accent-bright;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  &__id {
    font-family: 'JetBrains Mono', 'Menlo', monospace;
    color: $text-secondary;
  }

  &__status {
    font-size: 11px;
    color: $text-muted;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

/**
 * SDK event log
 */
.log {
  background: $bg-base;
  border-radius: 10px;
  padding: 10px;
  max-height: 200px;
  overflow-y: auto;
  font-family: 'JetBrains Mono', 'Menlo', 'Monaco', monospace;
  font-size: 11px;
  line-height: 1.7;

  &__line {
    white-space: pre-wrap;
    word-break: break-all;

    @each $name, $color in $log-colors {
      &.-#{$name} {
        color: $color;
      }
    }
  }

  &__time {
    color: $text-dim;
  }
}
</style>
