<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import {
  AWSDK,
  AWScope,
  AWCommand,
  AWInitError,
  AWOperationError,
  AWScopeError,
  AWSessionError,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
  shortDescription: string;
  description: string;
  icon: string;
  category: string;
  requiredScopes: string[];
}

interface LogEntry {
  time: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

const appConfig = ref<AppConfig | null>(null);
const status = ref<'idle' | 'connecting' | 'ready' | 'error'>('idle');
const statusText = ref('Idle');
const session = ref<AWSession | null>(null);
const user = ref<AWUserContext | null>(null);
const insideWallet = ref(false);
const logs = ref<LogEntry[]>([]);
const transferring = ref(false);
const paying = ref(false);
const refreshing = ref(false);
const checkingStatus = ref(false);
const loadingScopes = ref(false);
const loadingScopeData = ref(false);
const logContainer = ref<HTMLElement | null>(null);

let sdk: AWSDK | null = null;

function addLog(message: string, type: LogEntry['type'] = 'info') {
  const time = new Date().toLocaleTimeString();
  logs.value.push({ time, message, type });
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
  });
}

function setStatus(s: typeof status.value, text: string) {
  status.value = s;
  statusText.value = text;
}

function getParentOrigin(): string {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('parentOrigin');
  if (fromParam) {
    return fromParam;
  }

  if (window.parent !== window) {
    try {
      const referrer = document.referrer;
      if (referrer) {
        const url = new URL(referrer);
        return url.origin;
      }
    } catch {
      //
    }
  }

  return 'https://localhost:3310';
}

/**
 * Типизированная обработка ошибок SDK — демонстрирует все классы ошибок
 */
function handleSdkError(error: unknown): string {
  if (error instanceof AWOperationError) {
    return `Operation error [${error.errorCode}]: ${error.message} (opId: ${error.operationId})`;
  }
  if (error instanceof AWInitError) {
    return `Init error [${error.errorCode}]: ${error.message}`;
  }
  if (error instanceof AWSessionError) {
    return `Session error [${error.errorCode}]: ${error.message}`;
  }
  if (error instanceof AWScopeError) {
    return `Scope error [${error.errorCode}]: ${error.message}`;
  }
  if (error instanceof AWTimeoutError) {
    return `Timeout: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ── Operations ──────────────────────────────────────────────────────────────

async function handleTransfer() {
  if (!sdk) return;
  transferring.value = true;
  addLog('Preparing transfer operation...');

  try {
    const intent = await sdk.operations.prepare({
      type: 'transfer',
      amount: '10.00',
      currency: 'USDT',
      to: 'UQBvW8Z5huBkMJYdnfAEM5JqTNQXGbE1...',
      description: 'Test transfer from Example DApp',
    });
    addLog(`Transfer prepared: ${intent.operationId} (${intent.status})`, 'info');

    addLog('Requesting user confirmation...');
    const result = await sdk.operations.requestConfirmation(intent.operationId);
    addLog(`Transfer result: ${result.status}, txId: ${result.txId}`, 'success');
  } catch (error) {
    addLog(`Transfer failed: ${handleSdkError(error)}`, 'error');
  } finally {
    transferring.value = false;
  }
}

async function handlePayment() {
  if (!sdk) return;
  paying.value = true;
  addLog('Preparing payment operation...');

  try {
    const intent = await sdk.operations.prepare({
      type: 'payment',
      amount: '5.00',
      currency: 'USDT',
      to: 'UQDrjaLahLkMB-hMCmkzOyBuHJ186Kf3...',
      description: 'Test payment from Example DApp',
      metadata: { orderId: 'demo-001', item: 'Premium Plan' },
    });
    addLog(`Payment prepared: ${intent.operationId} (${intent.status})`, 'info');

    addLog('Requesting user confirmation...');
    const result = await sdk.operations.requestConfirmation(intent.operationId);
    addLog(`Payment result: ${result.status}, txId: ${result.txId}`, 'success');
  } catch (error) {
    addLog(`Payment failed: ${handleSdkError(error)}`, 'error');
  } finally {
    paying.value = false;
  }
}

// ── Session ─────────────────────────────────────────────────────────────────

async function handleRefresh() {
  if (!sdk) return;
  refreshing.value = true;
  addLog('Refreshing session...');

  try {
    await sdk.refreshSession();
    addLog('Session refreshed successfully', 'success');
  } catch (error) {
    addLog(`Refresh failed: ${handleSdkError(error)}`, 'error');
  } finally {
    refreshing.value = false;
  }
}

async function handleCheckStatus() {
  if (!sdk) return;
  checkingStatus.value = true;
  addLog('Checking session status...');

  try {
    const result = await sdk.status();
    addLog(
      `Status: ${result.status}, expires: ${new Date(result.expiresAt).toLocaleTimeString()}, scopes: [${result.grantedScopes.join(', ')}]`,
      'success',
    );
  } catch (error) {
    addLog(`Status check failed: ${handleSdkError(error)}`, 'error');
  } finally {
    checkingStatus.value = false;
  }
}

function handleGetSession() {
  if (!sdk) return;
  const current = sdk.getSession();
  if (current) {
    addLog(
      `getSession → token: ${current.sessionToken.slice(0, 12)}..., scopes: [${current.grantedScopes.join(', ')}], expires: ${new Date(current.expiresAt).toLocaleTimeString()}`,
      'success',
    );
  } else {
    addLog('getSession → null (not initialized)', 'warn');
  }
}

// ── Scopes ──────────────────────────────────────────────────────────────────

async function handleGetScopes() {
  if (!sdk) return;
  loadingScopes.value = true;
  addLog('Requesting granted scopes...');

  try {
    const scopes = await sdk.scopes.getScopes();
    addLog(`Granted scopes: [${scopes.join(', ')}]`, 'success');
  } catch (error) {
    addLog(`Get scopes failed: ${handleSdkError(error)}`, 'error');
  } finally {
    loadingScopes.value = false;
  }
}

async function handleGetScopeData() {
  if (!sdk) return;
  loadingScopeData.value = true;
  addLog('Requesting scope data...');

  try {
    const data = await sdk.scopes.getData();
    addLog(`Scope data: ${JSON.stringify(data)}`, 'success');
  } catch (error) {
    addLog(`Get scope data failed: ${handleSdkError(error)}`, 'error');
  } finally {
    loadingScopeData.value = false;
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function handleCheckCommands() {
  if (!sdk) return;
  const commands: { name: string; cmd: AWCommand }[] = [
    { name: 'Init', cmd: AWCommand.Init },
    { name: 'SessionRefresh', cmd: AWCommand.SessionRefresh },
    { name: 'PrepareOperation', cmd: AWCommand.PrepareOperation },
    { name: 'RequestConfirm', cmd: AWCommand.RequestConfirm },
    { name: 'GetSessionStatus', cmd: AWCommand.GetSessionStatus },
    { name: 'GetScopes', cmd: AWCommand.GetScopes },
    { name: 'GetScopesData', cmd: AWCommand.GetScopesData },
  ];

  for (const { name, cmd } of commands) {
    const available = sdk.isCommandAvailable(cmd);
    addLog(`${name}: ${available ? 'available' : 'not available'}`, available ? 'success' : 'warn');
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

onMounted(async () => {
  // Static check — works before SDK init
  insideWallet.value = AWSDK.isInsideWallet();
  addLog(`isInsideWallet: ${insideWallet.value}`, 'info');

  try {
    const res = await fetch('/config.json');
    appConfig.value = await res.json();
  } catch (error) {
    addLog(`Failed to load config: ${handleSdkError(error)}`, 'error');
    setStatus('error', 'Config Error');
    return;
  }

  const config = appConfig.value!;

  // Full SDK config with all options
  sdk = new AWSDK({
    appId: config.id,
    scopes: [...config.requiredScopes],
    parentOrigin: getParentOrigin(),
    debug: true,
    timeout: 30_000,
    persistSession: true,
    retry: {
      maxAttempts: 3,
      baseDelay: 1000,
    },
  });

  // ── Events ──────────────────────────────────────────────────────────────

  sdk.events.on('sdk.ready', (s: AWSession) => {
    addLog('SDK ready!', 'success');
    setStatus('ready', 'Connected');
    session.value = s;
    user.value = s.userContext ?? null;

    if (s.userContext?.displayName) {
      addLog(`User: ${s.userContext.displayName}`, 'info');
    }
    if (s.userContext?.walletAddress) {
      addLog(`Wallet: ${s.userContext.walletAddress}`, 'info');
    }
  });

  sdk.events.on('sdk.error', ({ code, message }: { code: string; message: string }) => {
    addLog(`SDK error: [${code}] ${message}`, 'error');
    setStatus('error', 'Error');
  });

  sdk.events.on('scopes.granted', ({ scopes }: { scopes: string[] }) => {
    addLog(`Scopes granted: ${scopes.join(', ')}`, 'success');
  });

  sdk.events.on('session.refreshed', ({ sessionToken, expiresAt }: { sessionToken: string; expiresAt: number }) => {
    addLog(`Session refreshed, expires: ${new Date(expiresAt).toLocaleTimeString()}`, 'info');
    if (session.value) {
      session.value = { ...session.value, sessionToken, expiresAt };
    }
  });

  sdk.events.on('session.expired', () => {
    addLog('Session expired!', 'warn');
    setStatus('error', 'Expired');
    session.value = null;
    user.value = null;
  });

  sdk.events.on('operation.rejected', ({ operationId, reason }: { operationId: string; reason: string }) => {
    addLog(`Operation ${operationId} rejected: ${reason}`, 'warn');
  });

  // ── Init ────────────────────────────────────────────────────────────────

  addLog('Initializing SDK...');
  setStatus('connecting', 'Connecting...');

  try {
    await sdk.init();
  } catch (error) {
    addLog(`Init failed: ${handleSdkError(error)}`, 'error');
    setStatus('error', 'Init Failed');
  }
});

onUnmounted(() => {
  sdk?.destroy();
});
</script>

<template>
  <div class="app-container">
    <!-- Info Card -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">{{ appConfig?.name ?? 'Loading...' }}</div>
        <span class="env-badge" :class="insideWallet ? 'inside' : 'outside'">
          {{ insideWallet ? 'In Wallet' : 'Standalone' }}
        </span>
      </div>
      <span class="status-badge" :class="status">{{ statusText }}</span>

      <div v-if="user" class="user-section">
        <img v-if="user.avatarUrl" :src="user.avatarUrl" class="user-avatar" alt="avatar" />
        <div class="user-info">
          <div v-if="user.displayName" class="user-name">{{ user.displayName }}</div>
          <div v-if="user.walletAddress" class="user-wallet">{{ user.walletAddress }}</div>
          <div v-if="user.userId" class="user-id">ID: {{ user.userId }}</div>
        </div>
      </div>

      <div v-if="session">
        <div class="info-row">
          <span class="info-label">Token</span>
          <span class="info-value">{{ session.sessionToken.slice(0, 20) }}...</span>
        </div>
        <div class="info-row">
          <span class="info-label">Expires</span>
          <span class="info-value">{{ new Date(session.expiresAt).toLocaleTimeString() }}</span>
        </div>
        <div>
          <div class="info-row">
            <span class="info-label">Scopes</span>
          </div>
          <div class="scopes-list">
            <span v-for="scope in session.grantedScopes" :key="scope" class="scope-tag">
              {{ scope }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Operations Card -->
    <div class="card">
      <div class="card-title">Operations</div>
      <button
        class="btn btn-primary"
        :disabled="!session || transferring"
        @click="handleTransfer"
      >
        {{ transferring ? 'Sending...' : 'Send Transfer (10 USDT)' }}
      </button>
      <button
        class="btn btn-primary"
        :disabled="!session || paying"
        @click="handlePayment"
      >
        {{ paying ? 'Paying...' : 'Send Payment (5 USDT)' }}
      </button>
    </div>

    <!-- Session Card -->
    <div class="card">
      <div class="card-title">Session</div>
      <button
        class="btn btn-secondary"
        :disabled="!session || refreshing"
        @click="handleRefresh"
      >
        {{ refreshing ? 'Refreshing...' : 'Refresh Session' }}
      </button>
      <button
        class="btn btn-secondary"
        :disabled="!session || checkingStatus"
        @click="handleCheckStatus"
      >
        {{ checkingStatus ? 'Checking...' : 'Check Session Status' }}
      </button>
      <button
        class="btn btn-secondary"
        :disabled="!sdk"
        @click="handleGetSession"
      >
        Get Session
      </button>
    </div>

    <!-- Scopes Card -->
    <div class="card">
      <div class="card-title">Scopes</div>
      <button
        class="btn btn-secondary"
        :disabled="!session || loadingScopes"
        @click="handleGetScopes"
      >
        {{ loadingScopes ? 'Loading...' : 'Get Scopes' }}
      </button>
      <button
        class="btn btn-secondary"
        :disabled="!session || loadingScopeData"
        @click="handleGetScopeData"
      >
        {{ loadingScopeData ? 'Loading...' : 'Get Scope Data' }}
      </button>
    </div>

    <!-- Commands Card -->
    <div class="card">
      <div class="card-title">Command Versioning</div>
      <button
        class="btn btn-secondary"
        :disabled="!session"
        @click="handleCheckCommands"
      >
        Check Available Commands
      </button>
    </div>

    <!-- Event Log Card -->
    <div class="card">
      <div class="card-title">Event Log</div>
      <div ref="logContainer" class="log-container">
        <div v-for="(entry, i) in logs" :key="i" class="log-entry" :class="entry.type">
          [{{ entry.time }}] {{ entry.message }}
        </div>
      </div>
    </div>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f6f8;
  color: #1a1a2e;
}
</style>

<style scoped>
.app-container {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f6f8;
  color: #1a1a2e;
  padding: 16px;
  min-height: 100vh;
  max-width: 400px;
  margin: 0 auto;
}

.card {
  background: white;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.card-header .card-title {
  margin-bottom: 0;
}

.card-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
}

.env-badge {
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
}

.env-badge.inside { background: #d4edda; color: #155724; }
.env-badge.outside { background: #fff3cd; color: #856404; }

.status-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 12px;
}

.status-badge.idle { background: #e9eaee; color: #6b6b77; }
.status-badge.connecting { background: #fff3cd; color: #856404; }
.status-badge.ready { background: #d4edda; color: #155724; }
.status-badge.error { background: #f8d7da; color: #721c24; }

.user-section {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
  margin-bottom: 4px;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.user-info {
  min-width: 0;
}

.user-name {
  font-size: 15px;
  font-weight: 600;
}

.user-wallet {
  font-size: 12px;
  color: #6b6b77;
  word-break: break-all;
}

.user-id {
  font-size: 11px;
  color: #9b9baa;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  color: #6b6b77;
}

.info-value {
  color: #1a1a2e;
  font-weight: 500;
  text-align: right;
  max-width: 60%;
  word-break: break-all;
}

.btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
  margin-bottom: 8px;
}

.btn:last-child {
  margin-bottom: 0;
}

.btn:active { opacity: 0.8; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary { background: #0075ff; color: white; }
.btn-secondary { background: #e9eaee; color: #1a1a2e; }

.log-container {
  background: #1a1a2e;
  border-radius: 12px;
  padding: 12px;
  max-height: 200px;
  overflow-y: auto;
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 11px;
  line-height: 1.6;
}

.log-entry {
  color: #b0b0b0;
}

.log-entry.info { color: #7cb2fd; }
.log-entry.success { color: #01c167; }
.log-entry.error { color: #ff6b6b; }
.log-entry.warn { color: #ffc107; }

.scopes-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.scope-tag {
  background: #eef0ff;
  color: #0075ff;
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
}
</style>
