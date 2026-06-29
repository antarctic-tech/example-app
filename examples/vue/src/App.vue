<script setup lang="ts">
/**
 * Example DApp (Vue 3) — demo integration with the Antarctic Wallet SDK.
 *
 * The entire flow lives in one SFC: types → helpers → SDK init → operations → UI.
 * Standalone run: http://localhost:5174
 * When embedded: the wallet loads this app inside an iframe and passes its
 * origin via the ?parentOrigin=... query parameter.
 */
import { ref, shallowRef, onMounted, onUnmounted, nextTick, computed } from 'vue';
import {
  AWSDK,
  AWCommand,
  AWInitError,
  AWOperationError,
  AWScopeError,
  AWSessionError,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type {
  AWOperationType,
  AWSession,
  AWUserContext,
} from '@antarctic-wallet/aw-sdk';

// ── Types ─────────────────────────────────────────────────────────────────

/** App configuration loaded from public/config.json */
interface AppConfig {
  id: string;
  name: string;
  requiredScopes: string[];
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

/** SDK commands used to probe version support via sdk.isCommandAvailable() */
const KNOWN_COMMANDS: { name: string; cmd: AWCommand }[] = [
  { name: 'Init', cmd: AWCommand.Init },
  { name: 'SessionRefresh', cmd: AWCommand.SessionRefresh },
  { name: 'PrepareOperation', cmd: AWCommand.PrepareOperation },
  { name: 'RequestConfirm', cmd: AWCommand.RequestConfirm },
  { name: 'GetSessionStatus', cmd: AWCommand.GetSessionStatus },
  { name: 'GetScopes', cmd: AWCommand.GetScopes },
  { name: 'GetScopesData', cmd: AWCommand.GetScopesData },
];

// ── State ─────────────────────────────────────────────────────────────────

const config = ref<AppConfig | null>(null);
const status = ref<AppStatus>('idle');
const session = ref<AWSession | null>(null);
const user = ref<AWUserContext | null>(null);
const insideWallet = ref(false);
const logs = ref<LogEntry[]>([]);
const busy = ref<string | null>(null);
const logContainer = ref<HTMLElement | null>(null);

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
onMounted(async () => {
  insideWallet.value = AWSDK.isInsideWallet();
  addLog(`isInsideWallet: ${insideWallet.value}`);

  const cfg: AppConfig = await fetch('./config.json').then((r) => r.json());
  config.value = cfg;

  const instance = new AWSDK({
    appId: cfg.id,
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
});

onUnmounted(() => {
  sdk.value?.destroy();
  sdk.value = null;
});

// ── Actions ───────────────────────────────────────────────────────────────

/**
 * Shared runner for every user-facing operation.
 * Flow: prepare() creates an intent → requestConfirmation() asks the user
 * to approve it in the wallet UI → the awaited result contains status/txId.
 */
async function runOperation(key: string, label: string, params: Parameters<AWSDK['operations']['prepare']>[0]) {
  if (!sdk.value) return;
  busy.value = key;
  addLog(`Preparing ${label} intent...`);
  try {
    const intent = await sdk.value.operations.prepare(params);
    addLog(`${label} intent prepared: ${intent.operationId} (${intent.status})`);
    addLog('Requesting user confirmation...');
    const result = await sdk.value.operations.requestConfirmation(intent.operationId);
    addLog(
      `${label} result: ${result.status}${result.txId ? `, txId: ${result.txId}` : ''}`,
      'success',
    );
  } catch (error) {
    addLog(`${label} failed: ${handleSdkError(error)}`, 'error');
  } finally {
    busy.value = null;
  }
}

/** Pay 5 USDT — prepares a payment intent and asks the user to confirm */
const pay = () =>
  runOperation('pay', 'Pay', {
    type: 'pay' as AWOperationType,
    amount: '5.00',
    currency: 'USDT',
    to: 'TRTNGawnjNjqaWrMUFCHfBJFuaxaXx1Ntk',
    description: 'Test payment from Example DApp',
    metadata: { orderId: 'demo-001' },
  });

/** Request a 10 USDT deposit to this app's wallet address */
const receive = () =>
  runOperation('receive', 'Receive', {
    type: 'receive' as AWOperationType,
    amount: '10.00',
    currency: 'USDT',
    to: '',
    description: 'Request deposit from Example DApp',
  });

/** Request additional scopes (balance, pay) beyond the ones declared in config */
const requestScopes = () =>
  runOperation('scopes', 'Scopes', {
    type: 'scopes' as AWOperationType,
    amount: '0',
    currency: 'USDT',
    to: '',
    description: 'Request additional scopes',
    metadata: { scopes: ['balance', 'pay'] },
  });

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

/** List the scopes currently granted to this app */
async function getScopes() {
  if (!sdk.value) return;
  try {
    const scopes = await sdk.value.scopes.getScopes();
    addLog(`Granted scopes: [${scopes.join(', ')}]`, 'success');
  } catch (error) {
    addLog(`Get scopes failed: ${handleSdkError(error)}`, 'error');
  }
}

/** Fetch the payload exposed by each granted scope (e.g. balance, user data) */
async function getScopeData() {
  if (!sdk.value) return;
  try {
    const data = await sdk.value.scopes.getData();
    addLog(`Scope data: ${JSON.stringify(data)}`, 'success');
  } catch (error) {
    addLog(`Get scope data failed: ${handleSdkError(error)}`, 'error');
  }
}

/** Probe each known SDK command for version support on the current host */
function checkCommands() {
  if (!sdk.value) return;
  for (const { name, cmd } of KNOWN_COMMANDS) {
    const ok = sdk.value.isCommandAvailable(cmd);
    addLog(`${name}: ${ok ? 'available' : 'not available'}`, ok ? 'success' : 'warn');
  }
}
</script>

<template>
  <div class="app">
    <header class="header">
      <h1 class="header__title">{{ config?.name ?? 'Loading...' }}</h1>
      <div class="header__badges">
        <span :class="insideWallet ? 'badge -inside' : 'badge -outside'">
          {{ insideWallet ? 'In Wallet' : 'Standalone' }}
        </span>
        <span :class="`status-dot -${status}`"></span>
        <span class="status-label">{{ status }}</span>
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
        <div class="panel__title">Operations</div>
        <button class="btn -accent" :disabled="disabled || busy === 'scopes'" @click="requestScopes">
          {{ busy === 'scopes' ? '...' : 'Request Scopes' }}
        </button>
        <button class="btn -accent" :disabled="disabled || busy === 'pay'" @click="pay">
          {{ busy === 'pay' ? '...' : 'Pay 5 USDT' }}
        </button>
        <button class="btn -accent" :disabled="disabled || busy === 'receive'" @click="receive">
          {{ busy === 'receive' ? '...' : 'Receive 10 USDT' }}
        </button>
      </section>

      <section class="panel">
        <div class="panel__title">Session</div>
        <button class="btn -ghost" :disabled="disabled || busy === 'refresh'" @click="refresh">
          Refresh
        </button>
        <button class="btn -ghost" :disabled="disabled || busy === 'status'" @click="checkStatus">
          Check Status
        </button>
      </section>

      <section class="panel">
        <div class="panel__title">Scopes</div>
        <button class="btn -ghost" :disabled="disabled" @click="getScopes">Get Scopes</button>
        <button class="btn -ghost" :disabled="disabled" @click="getScopeData">
          Get Scope Data
        </button>
      </section>

      <section class="panel">
        <div class="panel__title">Commands</div>
        <button class="btn -ghost" :disabled="disabled" @click="checkCommands">
          Check Available
        </button>
      </section>
    </div>

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
