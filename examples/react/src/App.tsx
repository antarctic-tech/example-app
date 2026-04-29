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
  AWInitError,
  AWOperationError,
  AWScopeError,
  AWSessionError,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Backend (B2B) intent demo helpers ─────────────────────────────────────
//
// IMPORTANT: real DApps MUST sign and POST these requests from THEIR server.
// API key/secret here is exposed in the browser ONLY because this is a demo
// to show wallet integrators what payload and signature the backend expects.
// Do NOT replicate this pattern in production — leaking api_secret in the
// browser allows anyone to impersonate the app.

/** Persisted credentials for the backend-intent demo panel */
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
 * the HMAC and forwards to AW. The browser never touches `api_secret` at rest,
 * but for this demo we still let the user paste it and ship it inside the
 * request body — clearly NOT how a real app should work.
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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
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

// ── Component ───────────────────────────────────────────────────────────────

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [session, setSession] = useState<AWSession | null>(null);
  const [user, setUser] = useState<AWUserContext | null>(null);
  const [insideWallet, setInsideWallet] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [appId, setAppId] = useState<string | null>(() => resolveStoredAppId());
  const [appIdInput, setAppIdInput] = useState('');
  const [backendCfg, setBackendCfg] = useState<BackendIntentConfig>(() => loadBackendConfig());
  const [intentType, setIntentType] = useState<'pay' | 'receive'>('pay');
  const [intentAmount, setIntentAmount] = useState('5.00');
  const [pendingIntents, setPendingIntents] = useState<PendingIntent[]>([]);

  const sdkRef = useRef<AWSDK | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  /**
   * Auto-refresh the pending intents list every 5 seconds whenever the user
   * has filled in both the API base URL and the bearer token.
   */
  useEffect(() => {
    if (!backendCfg.apiBase || !backendCfg.bearerToken) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void fetchPendingIntents();
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendCfg.apiBase, backendCfg.bearerToken]);

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

    if (!appId) {
      addLog('Waiting for appId...', 'warn');
      return;
    }

    (async () => {
      const cfg: AppConfig = await fetch('./config.json').then((r) => r.json());
      if (destroyed) return;
      setConfig(cfg);

      const sdk = new AWSDK({
        appId,
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
  }, [addLog, appId]);

  /** Persist user-supplied appId and trigger SDK bootstrap */
  function submitAppId(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = appIdInput.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(APP_ID_STORAGE_KEY, trimmed);
    } catch {
      //
    }
    setAppId(trimmed);
  }

  /** Clear stored appId and reset SDK so the user can enter a new one */
  function changeAppId() {
    try {
      localStorage.removeItem(APP_ID_STORAGE_KEY);
    } catch {
      //
    }
    sdkRef.current?.destroy();
    sdkRef.current = null;
    setAppId(null);
    setAppIdInput('');
    setConfig(null);
    setSession(null);
    setUser(null);
    setStatus('idle');
    setLogs([]);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

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

  /**
   * DEMO ONLY — pushes the credentials and intent payload to OUR demo backend
   * (`/api/intents`), which signs the HMAC and forwards to AW. A real app
   * would keep `apiSecret` exclusively on its server and never include it in
   * a request from the browser.
   */
  async function runBackendIntent() {
    if (!backendCfg.apiBase || !backendCfg.apiKey || !backendCfg.apiSecret || !backendCfg.telegramUserId) {
      addLog('Backend intent demo: fill apiBase, apiKey, apiSecret, telegramUserId first', 'warn');
      return;
    }
    const telegramUserIdNum = Number(backendCfg.telegramUserId);
    if (!Number.isFinite(telegramUserIdNum) || !Number.isInteger(telegramUserIdNum)) {
      addLog('Backend intent demo: telegramUserId must be an integer', 'warn');
      return;
    }
    const payload: IntentRelayPayload = {
      apiBase: backendCfg.apiBase,
      apiKey: backendCfg.apiKey,
      apiSecret: backendCfg.apiSecret,
      type: intentType,
      telegramUserId: telegramUserIdNum,
      amount: intentAmount,
    };
    setBusy('b2b');
    addLog(`[B2B ${intentType}] POST /api/intents (relayed to ${backendCfg.apiBase})`);
    try {
      const { operationId, status, rawResponse } = await createBackendIntent(payload);
      addLog(`[B2B ${intentType}] HTTP ${status} → ${rawResponse.slice(0, 200)}`, 'success');
      addLog(
        `[B2B ${intentType}] operationId: ${operationId}. Wait for the wallet shell + webhook to deliver the result.`,
        'success',
      );
    } catch (error) {
      addLog(`[B2B ${intentType}] failed: ${handleSdkError(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  /**
   * GET /api/v2/sdk/operations/intents — lists pending intents for the current
   * user. Requires the user's `Authorization: Bearer <jwt>` token.
   */
  async function fetchPendingIntents() {
    if (!backendCfg.apiBase) {
      addLog('Backend intent list: fill API Base URL first', 'warn');
      return;
    }
    if (!backendCfg.bearerToken) {
      addLog('Backend intent list: fill Bearer Token first', 'warn');
      return;
    }
    setBusy('intents');
    const url = `${backendCfg.apiBase.replace(/\/$/, '')}/api/v2/sdk/operations/intents`;
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${backendCfg.bearerToken}`,
        },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
      const parsed = JSON.parse(text) as { data?: PendingIntent[] };
      const list = Array.isArray(parsed.data) ? parsed.data : [];
      setPendingIntents(list);
    } catch (error) {
      addLog(`[Intents] failed: ${handleSdkError(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  /** Open wallet's approve/reject sheet for the chosen intent */
  async function approveIntent(intent: PendingIntent) {
    const sdk = sdkRef.current;
    if (!sdk) {
      addLog('SDK not ready', 'warn');
      return;
    }
    addLog(`[Intents] requesting confirmation for ${intent.operationId}...`);
    try {
      const result = await sdk.operations.requestConfirmation(intent.operationId);
      addLog(
        `[Intents] ${intent.operationId} → ${result.status}${result.txId ? `, txId: ${result.txId}` : ''}`,
        'success',
      );
      void fetchPendingIntents();
    } catch (error) {
      addLog(`[Intents] confirmation failed: ${handleSdkError(error)}`, 'error');
    }
  }

  function updateBackendCfg(patch: Partial<BackendIntentConfig>) {
    setBackendCfg((prev) => {
      const next = { ...prev, ...patch };
      saveBackendConfig(next);
      return next;
    });
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  const disabled = !session;

  if (!appId) {
    return (
      <div className="app">
        <header className="header">
          <h1 className="header__title">Example DApp (React)</h1>
          <div className="header__badges">
            <span className={insideWallet ? 'badge -inside' : 'badge -outside'}>
              {insideWallet ? 'In Wallet' : 'Standalone'}
            </span>
          </div>
        </header>
        <section className="panel">
          <div className="panel__title">Enter App ID</div>
          <form onSubmit={submitAppId}>
            <input
              className="input"
              type="text"
              autoFocus
              placeholder="e.g. dev"
              value={appIdInput}
              onChange={(e) => setAppIdInput(e.target.value)}
            />
            <button className="btn -accent" type="submit" disabled={!appIdInput.trim()}>
              Continue
            </button>
          </form>
        </section>
      </div>
    );
  }

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
          <span className="app-id">appId: {appId}</span>
          <button className="btn-link" onClick={changeAppId} type="button">
            Change
          </button>
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
          <div className="panel__title">Session</div>
          <button className="btn -ghost" disabled={disabled || busy === 'refresh'} onClick={refresh}>
            Refresh
          </button>
          <button className="btn -ghost" disabled={disabled || busy === 'status'} onClick={checkStatus}>
            Check Status
          </button>
        </section>

      </div>

      <section className="panel">
        <div className="panel__title">Backend Intent (DEMO ONLY)</div>
        <div className="warn-box">
          ⚠️ TESTING ONLY. Real apps NEVER send <code>apiSecret</code> from
          the browser — the secret stays on YOUR server. Here we relay through
          our demo backend (<code>/api/intents</code>) just to make the flow
          observable end-to-end.
        </div>
        <label className="field-label">API Base URL</label>
        <input
          className="input"
          type="text"
          placeholder="auto-derived from wallet origin"
          value={backendCfg.apiBase}
          onChange={(e) => updateBackendCfg({ apiBase: e.target.value })}
        />
        <label className="field-label">API Key</label>
        <input
          className="input"
          type="text"
          placeholder="X-Sdk-App-Key"
          value={backendCfg.apiKey}
          onChange={(e) => updateBackendCfg({ apiKey: e.target.value })}
        />
        <label className="field-label">API Secret</label>
        <input
          className="input"
          type="password"
          placeholder="HMAC secret"
          value={backendCfg.apiSecret}
          onChange={(e) => updateBackendCfg({ apiSecret: e.target.value })}
        />
        <label className="field-label">Bearer Token (for intents list)</label>
        <input
          className="input"
          type="password"
          placeholder="user JWT for Authorization header"
          value={backendCfg.bearerToken}
          onChange={(e) => updateBackendCfg({ bearerToken: e.target.value })}
        />
        <label className="field-label">Telegram User ID</label>
        <input
          className="input"
          type="text"
          placeholder="target user telegram id"
          value={backendCfg.telegramUserId}
          onChange={(e) => updateBackendCfg({ telegramUserId: e.target.value })}
        />
        <label className="field-label">Intent Type</label>
        <select
          className="input"
          value={intentType}
          onChange={(e) => setIntentType(e.target.value as 'pay' | 'receive')}
        >
          <option value="pay">pay</option>
          <option value="receive">receive</option>
        </select>
        <label className="field-label">Amount (USDT)</label>
        <input
          className="input"
          type="text"
          placeholder="5.00"
          value={intentAmount}
          onChange={(e) => setIntentAmount(e.target.value)}
        />
        <button
          className="btn -accent"
          disabled={busy === 'b2b'}
          onClick={runBackendIntent}
        >
          {busy === 'b2b' ? '...' : `Send ${intentType} intent`}
        </button>
      </section>

      <section className="panel">
        <div className="panel__title">Pending Intents</div>
        <button
          className="btn -ghost"
          disabled={busy === 'intents'}
          onClick={fetchPendingIntents}
        >
          {busy === 'intents' ? '...' : 'Refresh List'}
        </button>
        {pendingIntents.length === 0 ? (
          <div className="hint">No intents loaded.</div>
        ) : (
          <ul className="intent-list">
            {pendingIntents.map((it) => (
              <li key={it.operationId}>
                <button
                  className="intent-item"
                  type="button"
                  onClick={() => approveIntent(it)}
                  title="Open wallet sheet to approve or reject"
                >
                  <span className="intent-item__type">{it.type}</span>
                  <span className="intent-item__id">
                    {it.data?.amount
                      ? `${it.data.amount} USDT`
                      : it.data?.scopes?.length
                        ? it.data.scopes.join(', ')
                        : `${it.operationId.slice(0, 8)}…`}
                  </span>
                  <span className="intent-item__status">{it.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

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
