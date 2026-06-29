/**
 * Example DApp (React) — demo integration with the Antarctic Wallet SDK.
 *
 * The entire flow lives in one file: types → helpers → SDK init → operations → UI.
 * Standalone run: http://localhost:5175
 * When embedded: the wallet loads this app inside an iframe and passes its
 * origin via the ?parentOrigin=... query parameter.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Component ───────────────────────────────────────────────────────────────

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [session, setSession] = useState<AWSession | null>(null);
  const [user, setUser] = useState<AWUserContext | null>(null);
  const [insideWallet, setInsideWallet] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const sdkRef = useRef<AWSDK | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  /**
   * Full SDK bootstrap — runs once on mount:
   *   1. Detect whether we're embedded inside the wallet (isInsideWallet)
   *   2. Load public/config.json with appId and requiredScopes
   *   3. Create the AWSDK instance with debug/retry/persistSession
   *   4. Subscribe to every SDK event (ready/error/scopes/session/operation)
   *   5. sdk.init() — handshake with the host over postMessage
   */
  useEffect(() => {
    let destroyed = false;
    setInsideWallet(AWSDK.isInsideWallet());
    addLog(`isInsideWallet: ${AWSDK.isInsideWallet()}`);

    (async () => {
      const cfg: AppConfig = await fetch('./config.json').then((r) => r.json());
      if (destroyed) return;
      setConfig(cfg);

      const sdk = new AWSDK({
        appId: cfg.id,
        scopes: [...cfg.requiredScopes],
        parentOrigin: getParentOrigin(),
        debug: true,
        timeout: 30_000,
        persistSession: true,
        retry: { maxAttempts: 3, baseDelay: 1000 },
      });
      sdkRef.current = sdk;

      // Handshake finished — session token and userContext are available
      sdk.events.on('sdk.ready', (s: AWSession) => {
        addLog('SDK ready!', 'success');
        setStatus('ready');
        setSession(s);
        setUser(s.userContext ?? null);
      });

      // Fatal SDK error (init failed, host unreachable, etc.)
      sdk.events.on('sdk.error', ({ code, message }) => {
        addLog(`SDK error: [${code}] ${message}`, 'error');
        setStatus('error');
      });

      // User approved additional scopes
      sdk.events.on('scopes.granted', ({ scopes }) =>
        addLog(`Scopes granted: ${scopes.join(', ')}`, 'success'),
      );

      // Session token rotated (auto-refresh or explicit refreshSession())
      sdk.events.on('session.refreshed', ({ sessionToken, expiresAt }) => {
        addLog(`Session refreshed, expires: ${new Date(expiresAt).toLocaleTimeString()}`);
        setSession((prev) => (prev ? { ...prev, sessionToken, expiresAt } : prev));
      });

      // Session expired — re-initialisation is required
      sdk.events.on('session.expired', () => {
        addLog('Session expired!', 'warn');
        setStatus('error');
        setSession(null);
        setUser(null);
      });

      // User declined to confirm the operation in the wallet UI
      sdk.events.on('operation.rejected', ({ operationId, reason }) =>
        addLog(`Operation ${operationId} rejected: ${reason}`, 'warn'),
      );

      addLog('Initializing SDK...');
      setStatus('connecting');
      try {
        await sdk.init();
      } catch (error) {
        if (destroyed) return;
        addLog(`Init failed: ${handleSdkError(error)}`, 'error');
        setStatus('error');
      }
    })();

    return () => {
      destroyed = true;
      sdkRef.current?.destroy();
      sdkRef.current = null;
    };
  }, [addLog]);

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Shared runner for every user-facing operation.
   * Flow: prepare() creates an intent → requestConfirmation() asks the user
   * to approve it in the wallet UI → the awaited result contains status/txId.
   */
  async function runOperation(
    key: string,
    label: string,
    params: Parameters<AWSDK['operations']['prepare']>[0],
  ) {
    const sdk = sdkRef.current;
    if (!sdk) return;
    setBusy(key);
    addLog(`Preparing ${label} intent...`);
    try {
      const intent = await sdk.operations.prepare(params);
      addLog(`${label} intent prepared: ${intent.operationId} (${intent.status})`);
      addLog('Requesting user confirmation...');
      const result = await sdk.operations.requestConfirmation(intent.operationId);
      addLog(
        `${label} result: ${result.status}${result.txId ? `, txId: ${result.txId}` : ''}`,
        'success',
      );
    } catch (error) {
      addLog(`${label} failed: ${handleSdkError(error)}`, 'error');
    } finally {
      setBusy(null);
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
    const sdk = sdkRef.current;
    if (!sdk) return;
    setBusy('refresh');
    try {
      await sdk.refreshSession();
      addLog('Session refreshed successfully', 'success');
    } catch (error) {
      addLog(`Refresh failed: ${handleSdkError(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  /** Query the wallet for authoritative session status and granted scopes */
  async function checkStatus() {
    const sdk = sdkRef.current;
    if (!sdk) return;
    setBusy('status');
    try {
      const r = await sdk.status();
      addLog(
        `Status: ${r.status}, expires: ${new Date(r.expiresAt).toLocaleTimeString()}, scopes: [${r.grantedScopes.join(', ')}]`,
        'success',
      );
    } catch (error) {
      addLog(`Status check failed: ${handleSdkError(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  /** List the scopes currently granted to this app */
  async function getScopes() {
    const sdk = sdkRef.current;
    if (!sdk) return;
    try {
      const scopes = await sdk.scopes.getScopes();
      addLog(`Granted scopes: [${scopes.join(', ')}]`, 'success');
    } catch (error) {
      addLog(`Get scopes failed: ${handleSdkError(error)}`, 'error');
    }
  }

  /** Fetch the payload exposed by each granted scope (e.g. balance, user data) */
  async function getScopeData() {
    const sdk = sdkRef.current;
    if (!sdk) return;
    try {
      const data = await sdk.scopes.getData();
      addLog(`Scope data: ${JSON.stringify(data)}`, 'success');
    } catch (error) {
      addLog(`Get scope data failed: ${handleSdkError(error)}`, 'error');
    }
  }

  /** Probe each known SDK command for version support on the current host */
  function checkCommands() {
    const sdk = sdkRef.current;
    if (!sdk) return;
    for (const { name, cmd } of KNOWN_COMMANDS) {
      const ok = sdk.isCommandAvailable(cmd);
      addLog(`${name}: ${ok ? 'available' : 'not available'}`, ok ? 'success' : 'warn');
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  const disabled = !session;

  return (
    <div className="app">
      <header className="header">
        <h1 className="header__title">{config?.name ?? 'Loading...'}</h1>
        <div className="header__badges">
          <span className={insideWallet ? 'badge -inside' : 'badge -outside'}>
            {insideWallet ? 'In Wallet' : 'Standalone'}
          </span>
          <span className={`status-dot -${status}`} />
          <span className="status-label">{status}</span>
        </div>
      </header>

      {user && (
        <section className="panel">
          <div className="user">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="user__avatar" />}
            <div>
              {user.displayName && <div className="user__name">{user.displayName}</div>}
              {user.walletAddress && <div className="user__wallet">{user.walletAddress}</div>}
              {user.userId && <div className="user__id">ID: {user.userId}</div>}
            </div>
          </div>
        </section>
      )}

      {session && (
        <section className="panel">
          <div className="panel__title">Session</div>
          <div className="info-grid">
            <span className="info-grid__label">Token</span>
            <span className="info-grid__value">{session.sessionToken.slice(0, 20)}...</span>
            <span className="info-grid__label">Expires</span>
            <span className="info-grid__value">
              {new Date(session.expiresAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="scopes">
            {session.grantedScopes.map((s) => (
              <span key={s} className="scope-chip">
                {s}
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="actions-grid">
        <section className="panel">
          <div className="panel__title">Operations</div>
          <button className="btn -accent" disabled={disabled || busy === 'scopes'} onClick={requestScopes}>
            {busy === 'scopes' ? '...' : 'Request Scopes'}
          </button>
          <button className="btn -accent" disabled={disabled || busy === 'pay'} onClick={pay}>
            {busy === 'pay' ? '...' : 'Pay 5 USDT'}
          </button>
          <button className="btn -accent" disabled={disabled || busy === 'receive'} onClick={receive}>
            {busy === 'receive' ? '...' : 'Receive 10 USDT'}
          </button>
        </section>

        <section className="panel">
          <div className="panel__title">Session</div>
          <button className="btn -ghost" disabled={disabled || busy === 'refresh'} onClick={refresh}>
            Refresh
          </button>
          <button className="btn -ghost" disabled={disabled || busy === 'status'} onClick={checkStatus}>
            Check Status
          </button>
        </section>

        <section className="panel">
          <div className="panel__title">Scopes</div>
          <button className="btn -ghost" disabled={disabled} onClick={getScopes}>
            Get Scopes
          </button>
          <button className="btn -ghost" disabled={disabled} onClick={getScopeData}>
            Get Scope Data
          </button>
        </section>

        <section className="panel">
          <div className="panel__title">Commands</div>
          <button className="btn -ghost" disabled={disabled} onClick={checkCommands}>
            Check Available
          </button>
        </section>
      </div>

      <section className="panel">
        <div className="panel__title">Event Log</div>
        <div ref={logRef} className="log">
          {logs.map((e, i) => (
            <div key={i} className={`log__line -${e.type}`}>
              <span className="log__time">[{e.time}]</span> {e.message}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
