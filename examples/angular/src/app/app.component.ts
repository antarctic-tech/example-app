/**
 * Example DApp (Angular) — demo integration with the Antarctic Wallet SDK.
 *
 * The entire flow lives in one standalone component: types → helpers → SDK
 * init → operations → UI. Uses signals, OnPush change detection, and the
 * new control-flow syntax (@if, @for).
 *
 * Standalone run: http://localhost:5176
 * When embedded: the wallet loads this app inside an iframe and passes its
 * origin via the ?parentOrigin=... query parameter.
 */
import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import {
  AWSDK,
  AWInitError,
  AWOperationError,
  AWScopeError,
  AWSessionError,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────

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

// ── Backend (B2B) intent demo helpers ──────────────────────────────────────
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

// ── Component ──────────────────────────────────────────────────────────────

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!appId()) {
      <div class="app">
        <header class="header">
          <h1 class="header__title">Example DApp (Angular)</h1>
          <div class="header__badges">
            <span [class]="insideWallet() ? 'badge -inside' : 'badge -outside'">
              {{ insideWallet() ? 'In Wallet' : 'Standalone' }}
            </span>
          </div>
        </header>
        <section class="panel">
          <div class="panel__title">Enter App ID</div>
          <form (submit)="submitAppId($event)">
            <input
              class="input"
              type="text"
              placeholder="e.g. dev"
              autofocus
              [value]="appIdInput()"
              (input)="appIdInput.set(toInputValue($event))"
            />
            <button class="btn -accent" type="submit" [disabled]="!appIdInput().trim()">
              Continue
            </button>
          </form>
        </section>
      </div>
    } @else {
    <div class="app">
      <header class="header">
        <h1 class="header__title">{{ config()?.name ?? 'Loading...' }}</h1>
        <div class="header__badges">
          <span [class]="insideWallet() ? 'badge -inside' : 'badge -outside'">
            {{ insideWallet() ? 'In Wallet' : 'Standalone' }}
          </span>
          <span [class]="'status-dot -' + status()"></span>
          <span class="status-label">{{ status() }}</span>
          <span class="app-id">appId: {{ appId() }}</span>
          <button class="btn-link" type="button" (click)="changeAppId()">Change</button>
        </div>
      </header>

      @if (user(); as u) {
        <section class="panel">
          <div class="user">
            @if (u.avatarUrl) {
              <img [src]="u.avatarUrl" alt="" class="user__avatar" />
            }
            <div>
              @if (u.displayName) {
                <div class="user__name">{{ u.displayName }}</div>
              }
              @if (u.walletAddress) {
                <div class="user__wallet">{{ u.walletAddress }}</div>
              }
              @if (u.userId) {
                <div class="user__id">ID: {{ u.userId }}</div>
              }
            </div>
          </div>
        </section>
      }

      @if (session(); as s) {
        <section class="panel">
          <div class="panel__title">Session</div>
          <div class="info-grid">
            <span class="info-grid__label">Token</span>
            <span class="info-grid__value">{{ s.sessionToken.slice(0, 20) }}...</span>
            <span class="info-grid__label">Expires</span>
            <span class="info-grid__value">{{ formatTime(s.expiresAt) }}</span>
          </div>
          <div class="scopes">
            @for (scope of s.grantedScopes; track scope) {
              <span class="scope-chip">{{ scope }}</span>
            }
          </div>
        </section>
      }

      <div class="actions-grid">
        <section class="panel">
          <div class="panel__title">Session</div>
          <button
            class="btn -ghost"
            [disabled]="disabled() || busy() === 'refresh'"
            (click)="refresh()"
          >
            Refresh
          </button>
          <button
            class="btn -ghost"
            [disabled]="disabled() || busy() === 'status'"
            (click)="checkStatus()"
          >
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
          [value]="backendCfg().apiBase"
          (input)="updateBackendField('apiBase', $event)"
        />
        <label class="field-label">API Key</label>
        <input
          class="input"
          type="text"
          placeholder="X-Sdk-App-Key"
          [value]="backendCfg().apiKey"
          (input)="updateBackendField('apiKey', $event)"
        />
        <label class="field-label">API Secret</label>
        <input
          class="input"
          type="password"
          placeholder="HMAC secret"
          [value]="backendCfg().apiSecret"
          (input)="updateBackendField('apiSecret', $event)"
        />
        <label class="field-label">Bearer Token (for intents list)</label>
        <input
          class="input"
          type="password"
          placeholder="user JWT for Authorization header"
          [value]="backendCfg().bearerToken"
          (input)="updateBackendField('bearerToken', $event)"
        />
        <label class="field-label">Telegram User ID</label>
        <input
          class="input"
          type="text"
          placeholder="target user telegram id"
          [value]="backendCfg().telegramUserId"
          (input)="updateBackendField('telegramUserId', $event)"
        />
        <label class="field-label">Intent Type</label>
        <select
          class="input"
          [value]="intentType()"
          (change)="setIntentType($event)"
        >
          <option value="pay">pay</option>
          <option value="receive">receive</option>
        </select>
        <label class="field-label">Amount (USDT)</label>
        <input
          class="input"
          type="text"
          placeholder="5.00"
          [value]="intentAmount()"
          (input)="intentAmount.set(toInputValue($event))"
        />
        <button
          class="btn -accent"
          [disabled]="busy() === 'b2b'"
          (click)="runBackendIntent()"
        >
          {{ busy() === 'b2b' ? '...' : 'Send ' + intentType() + ' intent' }}
        </button>
      </section>

      <section class="panel">
        <div class="panel__title">Pending Intents</div>
        <button
          class="btn -ghost"
          [disabled]="busy() === 'intents'"
          (click)="fetchPendingIntents()"
        >
          {{ busy() === 'intents' ? '...' : 'Refresh List' }}
        </button>
        @if (pendingIntents().length === 0) {
          <div class="hint">No intents loaded.</div>
        } @else {
          <ul class="intent-list">
            @for (it of pendingIntents(); track it.operationId) {
              <li>
                <button
                  class="intent-item"
                  type="button"
                  (click)="approveIntent(it)"
                  title="Open wallet sheet to approve or reject"
                >
                  <span class="intent-item__type">{{ it.type }}</span>
                  <span class="intent-item__id">{{ formatIntentSummary(it) }}</span>
                  <span class="intent-item__status">{{ it.status }}</span>
                </button>
              </li>
            }
          </ul>
        }
      </section>

      <section class="panel">
        <div class="panel__title">Event Log</div>
        <div #logContainer class="log">
          @for (entry of logs(); track $index) {
            <div [class]="'log__line -' + entry.type">
              <span class="log__time">[{{ entry.time }}]</span> {{ entry.message }}
            </div>
          }
        </div>
      </section>
    </div>
    }
  `,
})
export class AppComponent implements OnInit, OnDestroy, AfterViewChecked {
  readonly config = signal<AppConfig | null>(null);
  readonly status = signal<AppStatus>('idle');
  readonly session = signal<AWSession | null>(null);
  readonly user = signal<AWUserContext | null>(null);
  readonly insideWallet = signal(false);
  readonly logs = signal<LogEntry[]>([]);
  readonly busy = signal<string | null>(null);
  readonly disabled = computed(() => !this.session());
  readonly appId = signal<string | null>(resolveStoredAppId());
  readonly appIdInput = signal('');
  readonly backendCfg = signal<BackendIntentConfig>(loadBackendConfig());
  readonly intentType = signal<'pay' | 'receive'>('pay');
  readonly intentAmount = signal('5.00');
  readonly pendingIntents = signal<PendingIntent[]>([]);

  private readonly logContainer = viewChild<ElementRef<HTMLDivElement>>('logContainer');
  private sdk: AWSDK | null = null;
  private scrollPending = false;
  private intentsPollId: number | null = null;

  constructor() {
    effect(() => {
      this.logs();
      this.scrollPending = true;
    });
    effect(() => {
      const cfg = this.backendCfg();
      if (this.intentsPollId !== null) {
        window.clearInterval(this.intentsPollId);
        this.intentsPollId = null;
      }
      if (!cfg.apiBase || !cfg.bearerToken) return;
      void this.fetchPendingIntents();
      this.intentsPollId = window.setInterval(() => {
        void this.fetchPendingIntents();
      }, 5000);
    });
  }

  ngAfterViewChecked(): void {
    if (!this.scrollPending) return;
    const el = this.logContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
    this.scrollPending = false;
  }

  /**
   * Full SDK bootstrap — runs once on init:
   *   1. Detect whether we're embedded inside the wallet (isInsideWallet)
   *   2. Load public/config.json with appId and requiredScopes
   *   3. Create the AWSDK instance with debug/retry/persistSession
   *   4. Subscribe to every SDK event (ready/error/scopes/session/operation)
   *   5. sdk.init() — handshake with the host over postMessage
   */
  async ngOnInit(): Promise<void> {
    this.insideWallet.set(AWSDK.isInsideWallet());
    this.addLog(`isInsideWallet: ${AWSDK.isInsideWallet()}`);

    const currentAppId = this.appId();
    if (!currentAppId) {
      this.addLog('Waiting for appId...', 'warn');
      return;
    }
    await this.bootstrap(currentAppId);
  }

  private async bootstrap(currentAppId: string): Promise<void> {
    const cfg: AppConfig = await fetch('./config.json').then((r) => r.json());
    this.config.set(cfg);

    const sdk = new AWSDK({
      appId: currentAppId,
      scopes: [...cfg.requiredScopes],
      parentOrigin: getParentOrigin(),
      debug: true,
      timeout: 30_000,
      persistSession: true,
      retry: { maxAttempts: 3, baseDelay: 1000 },
    });
    this.sdk = sdk;

    // Handshake finished — session token and userContext are available
    sdk.events.on('sdk.ready', (s: AWSession) => {
      this.addLog('SDK ready!', 'success');
      this.status.set('ready');
      this.session.set(s);
      this.user.set(s.userContext ?? null);
    });

    // Fatal SDK error (init failed, host unreachable, etc.)
    sdk.events.on('sdk.error', ({ code, message }) => {
      this.addLog(`SDK error: [${code}] ${message}`, 'error');
      this.status.set('error');
    });

    // User approved additional scopes
    sdk.events.on('scopes.granted', ({ scopes }) =>
      this.addLog(`Scopes granted: ${scopes.join(', ')}`, 'success'),
    );

    // Session token rotated (auto-refresh or explicit refreshSession())
    sdk.events.on('session.refreshed', ({ sessionToken, expiresAt }) => {
      this.addLog(`Session refreshed, expires: ${this.formatTime(expiresAt)}`);
      this.session.update((prev) => (prev ? { ...prev, sessionToken, expiresAt } : prev));
    });

    // Session expired — re-initialisation is required
    sdk.events.on('session.expired', () => {
      this.addLog('Session expired!', 'warn');
      this.status.set('error');
      this.session.set(null);
      this.user.set(null);
    });

    // User declined to confirm the operation in the wallet UI
    sdk.events.on('operation.rejected', ({ operationId, reason }) =>
      this.addLog(`Operation ${operationId} rejected: ${reason}`, 'warn'),
    );

    this.addLog('Initializing SDK...');
    this.status.set('connecting');
    try {
      await sdk.init();
    } catch (error) {
      this.addLog(`Init failed: ${handleSdkError(error)}`, 'error');
      this.status.set('error');
    }
  }

  ngOnDestroy(): void {
    this.sdk?.destroy();
    this.sdk = null;
    if (this.intentsPollId !== null) {
      window.clearInterval(this.intentsPollId);
      this.intentsPollId = null;
    }
  }

  /** Persist user-supplied appId and trigger SDK bootstrap */
  submitAppId(event: Event): void {
    event.preventDefault();
    const trimmed = this.appIdInput().trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(APP_ID_STORAGE_KEY, trimmed);
    } catch {
      //
    }
    this.appId.set(trimmed);
    this.bootstrap(trimmed).catch((error) => {
      this.addLog(`Bootstrap failed: ${handleSdkError(error)}`, 'error');
    });
  }

  /** Clear stored appId and reset SDK so the user can enter a new one */
  changeAppId(): void {
    try {
      localStorage.removeItem(APP_ID_STORAGE_KEY);
    } catch {
      //
    }
    this.sdk?.destroy();
    this.sdk = null;
    this.appId.set(null);
    this.appIdInput.set('');
    this.config.set(null);
    this.session.set(null);
    this.user.set(null);
    this.status.set('idle');
    this.logs.set([]);
  }

  toInputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Force-rotate the session token ahead of its expiry */
  async refresh(): Promise<void> {
    if (!this.sdk) return;
    this.busy.set('refresh');
    try {
      await this.sdk.refreshSession();
      this.addLog('Session refreshed successfully', 'success');
    } catch (error) {
      this.addLog(`Refresh failed: ${handleSdkError(error)}`, 'error');
    } finally {
      this.busy.set(null);
    }
  }

  /** Query the wallet for authoritative session status and granted scopes */
  async checkStatus(): Promise<void> {
    if (!this.sdk) return;
    this.busy.set('status');
    try {
      const r = await this.sdk.status();
      this.addLog(
        `Status: ${r.status}, expires: ${this.formatTime(r.expiresAt)}, scopes: [${r.grantedScopes.join(', ')}]`,
        'success',
      );
    } catch (error) {
      this.addLog(`Status check failed: ${handleSdkError(error)}`, 'error');
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * DEMO ONLY — backend-to-backend intent flow run from the browser.
   *
   * Real apps must perform this request from their server because it requires
   * the app's api_secret to sign the HMAC. Here we sign in the browser purely
   * to demonstrate the request/response shape to integrators.
   */
  async runBackendIntent(): Promise<void> {
    const cfg = this.backendCfg();
    if (!cfg.apiBase || !cfg.apiKey || !cfg.apiSecret || !cfg.telegramUserId) {
      this.addLog('Backend intent demo: fill apiBase, apiKey, apiSecret, telegramUserId first', 'warn');
      return;
    }
    const telegramUserIdNum = Number(cfg.telegramUserId);
    if (!Number.isFinite(telegramUserIdNum) || !Number.isInteger(telegramUserIdNum)) {
      this.addLog('Backend intent demo: telegramUserId must be an integer', 'warn');
      return;
    }
    const type = this.intentType();
    const payload: IntentRelayPayload = {
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      type,
      telegramUserId: telegramUserIdNum,
      amount: this.intentAmount(),
    };
    this.busy.set('b2b');
    this.addLog(`[B2B ${type}] POST /api/intents (relayed to ${cfg.apiBase})`);
    try {
      const { operationId, status, rawResponse } = await createBackendIntent(payload);
      this.addLog(`[B2B ${type}] HTTP ${status} → ${rawResponse.slice(0, 200)}`, 'success');
      this.addLog(
        `[B2B ${type}] operationId: ${operationId}. Wait for the wallet shell + webhook to deliver the result.`,
        'success',
      );
    } catch (error) {
      this.addLog(`[B2B ${type}] failed: ${handleSdkError(error)}`, 'error');
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * GET /api/v2/sdk/operations/intents — lists pending intents for the current
   * user. Requires the user's `Authorization: Bearer <jwt>` token.
   */
  async fetchPendingIntents(): Promise<void> {
    const cfg = this.backendCfg();
    if (!cfg.apiBase) {
      this.addLog('Backend intent list: fill API Base URL first', 'warn');
      return;
    }
    if (!cfg.bearerToken) {
      this.addLog('Backend intent list: fill Bearer Token first', 'warn');
      return;
    }
    this.busy.set('intents');
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
      this.pendingIntents.set(list);
    } catch (error) {
      this.addLog(`[Intents] failed: ${handleSdkError(error)}`, 'error');
    } finally {
      this.busy.set(null);
    }
  }

  /** Open wallet's approve/reject sheet for the chosen intent */
  async approveIntent(intent: PendingIntent): Promise<void> {
    if (!this.sdk) {
      this.addLog('SDK not ready', 'warn');
      return;
    }
    this.addLog(`[Intents] requesting confirmation for ${intent.operationId}...`);
    try {
      const result = await this.sdk.operations.requestConfirmation(intent.operationId);
      this.addLog(
        `[Intents] ${intent.operationId} → ${result.status}${result.txId ? `, txId: ${result.txId}` : ''}`,
        'success',
      );
      void this.fetchPendingIntents();
    } catch (error) {
      this.addLog(`[Intents] confirmation failed: ${handleSdkError(error)}`, 'error');
    }
  }

  formatIntentSummary(it: PendingIntent): string {
    if (it.data?.amount) return `${it.data.amount} USDT`;
    if (it.data?.scopes && it.data.scopes.length > 0) return it.data.scopes.join(', ');
    return `${it.operationId.slice(0, 8)}…`;
  }

  setIntentType(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as 'pay' | 'receive';
    this.intentType.set(value);
  }

  updateBackendField(field: keyof BackendIntentConfig, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.backendCfg.update((prev) => {
      const next = { ...prev, [field]: value };
      saveBackendConfig(next);
      return next;
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  private addLog = (message: string, type: LogEntry['type'] = 'info'): void => {
    this.logs.update((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), message, type },
    ]);
  };
}
