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
  AWCommand,
  AWInitError,
  AWOperationError,
  AWScopeError,
  AWSessionError,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type {
  AWOperationIntentParams,
  AWOperationType,
  AWSession,
  AWUserContext,
} from '@antarctic-wallet/aw-sdk';

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────────────────

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="app">
      <header class="header">
        <h1 class="header__title">{{ config()?.name ?? 'Loading...' }}</h1>
        <div class="header__badges">
          <span [class]="insideWallet() ? 'badge -inside' : 'badge -outside'">
            {{ insideWallet() ? 'In Wallet' : 'Standalone' }}
          </span>
          <span [class]="'status-dot -' + status()"></span>
          <span class="status-label">{{ status() }}</span>
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
          <div class="panel__title">Operations</div>
          <button
            class="btn -accent"
            [disabled]="disabled() || busy() === 'scopes'"
            (click)="requestScopes()"
          >
            {{ busy() === 'scopes' ? '...' : 'Request Scopes' }}
          </button>
          <button
            class="btn -accent"
            [disabled]="disabled() || busy() === 'pay'"
            (click)="pay()"
          >
            {{ busy() === 'pay' ? '...' : 'Pay 5 USDT' }}
          </button>
          <button
            class="btn -accent"
            [disabled]="disabled() || busy() === 'receive'"
            (click)="receive()"
          >
            {{ busy() === 'receive' ? '...' : 'Receive 10 USDT' }}
          </button>
        </section>

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

        <section class="panel">
          <div class="panel__title">Scopes</div>
          <button class="btn -ghost" [disabled]="disabled()" (click)="getScopes()">
            Get Scopes
          </button>
          <button class="btn -ghost" [disabled]="disabled()" (click)="getScopeData()">
            Get Scope Data
          </button>
        </section>

        <section class="panel">
          <div class="panel__title">Commands</div>
          <button class="btn -ghost" [disabled]="disabled()" (click)="checkCommands()">
            Check Available
          </button>
        </section>
      </div>

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

  private readonly logContainer = viewChild<ElementRef<HTMLDivElement>>('logContainer');
  private sdk: AWSDK | null = null;
  private scrollPending = false;

  constructor() {
    effect(() => {
      this.logs();
      this.scrollPending = true;
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

    const cfg: AppConfig = await fetch('./config.json').then((r) => r.json());
    this.config.set(cfg);

    const sdk = new AWSDK({
      appId: cfg.id,
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
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Pay 5 USDT — prepares a payment intent and asks the user to confirm */
  pay(): Promise<void> {
    return this.runOperation('pay', 'Pay', {
      type: 'pay' as AWOperationType,
      amount: '5.00',
      currency: 'USDT',
      to: 'TRTNGawnjNjqaWrMUFCHfBJFuaxaXx1Ntk',
      description: 'Test payment from Example DApp',
      metadata: { orderId: 'demo-001' },
    });
  }

  /** Request a 10 USDT deposit to this app's wallet address */
  receive(): Promise<void> {
    return this.runOperation('receive', 'Receive', {
      type: 'receive' as AWOperationType,
      amount: '10.00',
      currency: 'USDT',
      to: '',
      description: 'Request deposit from Example DApp',
    });
  }

  /** Request additional scopes (balance, pay) beyond the ones declared in config */
  requestScopes(): Promise<void> {
    return this.runOperation('scopes', 'Scopes', {
      type: 'scopes' as AWOperationType,
      amount: '0',
      currency: 'USDT',
      to: '',
      description: 'Request additional scopes',
      metadata: { scopes: ['balance', 'pay'] },
    });
  }

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

  /** List the scopes currently granted to this app */
  async getScopes(): Promise<void> {
    if (!this.sdk) return;
    try {
      const scopes = await this.sdk.scopes.getScopes();
      this.addLog(`Granted scopes: [${scopes.join(', ')}]`, 'success');
    } catch (error) {
      this.addLog(`Get scopes failed: ${handleSdkError(error)}`, 'error');
    }
  }

  /** Fetch the payload exposed by each granted scope (e.g. balance, user data) */
  async getScopeData(): Promise<void> {
    if (!this.sdk) return;
    try {
      const data = await this.sdk.scopes.getData();
      this.addLog(`Scope data: ${JSON.stringify(data)}`, 'success');
    } catch (error) {
      this.addLog(`Get scope data failed: ${handleSdkError(error)}`, 'error');
    }
  }

  /** Probe each known SDK command for version support on the current host */
  checkCommands(): void {
    if (!this.sdk) return;
    for (const { name, cmd } of KNOWN_COMMANDS) {
      const ok = this.sdk.isCommandAvailable(cmd);
      this.addLog(`${name}: ${ok ? 'available' : 'not available'}`, ok ? 'success' : 'warn');
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  private async runOperation(
    key: string,
    label: string,
    params: AWOperationIntentParams,
  ): Promise<void> {
    if (!this.sdk) return;
    this.busy.set(key);
    this.addLog(`Preparing ${label} intent...`);
    try {
      const intent = await this.sdk.operations.prepare(params);
      this.addLog(`${label} intent prepared: ${intent.operationId} (${intent.status})`);
      this.addLog('Requesting user confirmation...');
      const result = await this.sdk.operations.requestConfirmation(intent.operationId);
      this.addLog(
        `${label} result: ${result.status}${result.txId ? `, txId: ${result.txId}` : ''}`,
        'success',
      );
    } catch (error) {
      this.addLog(`${label} failed: ${handleSdkError(error)}`, 'error');
    } finally {
      this.busy.set(null);
    }
  }

  private addLog = (message: string, type: LogEntry['type'] = 'info'): void => {
    this.logs.update((prev) => [
      ...prev,
      { time: new Date().toLocaleTimeString(), message, type },
    ]);
  };
}
