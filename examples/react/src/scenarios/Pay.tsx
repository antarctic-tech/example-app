/**
 * Сценарий: вход + односторонний платёж (донат).
 *
 * После входа ваш бэкенд создаёт интент pay через POST /api/intents.
 * Возврата нет. Скоупы заданы в этом файле.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

export function Pay() {
  const sdkRef = useRef<AWSDK | null>(null);
  const sessionRef = useRef<AWSession | null>(null);
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [appName, setAppName] = useState('Загрузка...');
  const [user, setUser] = useState<AWUserContext | null>(null);
  const [trustedUserId, setTrustedUserId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasSdk, setHasSdk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let instance: AWSDK | null = null;

    async function prepareSdk() {
      const config: AppConfig = await fetch('./config.json').then((r) => r.json());
      if (cancelled) return;
      setAppName(config.name);

      instance = new AWSDK({
        appId: config.id,
        scopes: [...SCOPES],
        parentOrigin: getParentOrigin(),
        persistSession: true,
      });
      sdkRef.current = instance;
      setHasSdk(true);

      instance.backButton.onClick(() => {
        navigate('/');
      });

      instance.events.on('sdk.ready', (s: AWSession) => {
        setStatus('ready');
        sessionRef.current = s;
        setUser(s.userContext ?? null);
        const idToken = instance!.idToken ?? s.idToken;
        if (!idToken) {
          setMessage('Нет idToken.');
          return;
        }
        void verifyIdentity(idToken)
          .then((userId) => {
            setTrustedUserId(userId);
            setMessage('Вход выполнен. Можно отправить донат.');
          })
          .catch((error: unknown) => {
            setMessage(asErrorMessage(error));
          });
      });

      instance.events.on('sdk.error', ({ message: text }) => {
        setStatus('error');
        setMessage(text);
      });

      instance.events.on('session.expired', () => {
        setStatus('error');
        setUser(null);
        setTrustedUserId(null);
        setMessage('Сессия истекла — войдите снова.');
      });

      instance.events.on('operation.rejected', ({ reason }) => {
        setMessage(`Отклонено: ${reason}`);
      });

      if (cancelled) return;
      setLoggingIn(true);
      setStatus('connecting');
      try {
        const pending = instance.init();
        try {
          instance.backButton.show();
        } catch (error) {
          setMessage(asErrorMessage(error));
        }
        await pending;
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setMessage(asErrorMessage(error));
      } finally {
        if (!cancelled) setLoggingIn(false);
      }
    }

    void prepareSdk();

    return () => {
      cancelled = true;
      try {
        instance?.backButton.hide();
      } catch {
        // хост мог уже закрыть канал
      }
      instance?.destroy();
      sdkRef.current = null;
    };
  }, [navigate]);

  function currentIdToken(): string | null {
    return sdkRef.current?.idToken ?? sessionRef.current?.idToken ?? null;
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
    return data.userId;
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
    const instance = sdkRef.current;
    if (!instance || !currentIdToken()) {
      setMessage('Сначала войдите через кошелёк.');
      return;
    }
    setBusy(true);
    setMessage('Создаём pay-интент…');
    try {
      const { operationId, status: intentStatus, failureReason } =
        await createPayIntent(DONATE_AMOUNT);
      if (intentStatus === 'failed') {
        setMessage(`Донат: ${failureReason ?? 'failed'}`);
        return;
      }
      if (intentStatus === 'approved') {
        setMessage('Донат: approved');
        return;
      }
      setMessage('Подтвердите в кошельке…');
      const result = await instance.operations.requestConfirmation(operationId);
      setMessage(`Донат: ${result.status}${result.txId ? ` · ${result.txId}` : ''}`);
    } catch (error) {
      setMessage(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    const instance = sdkRef.current;
    if (!instance || loggingIn) return;

    setLoggingIn(true);
    setStatus('connecting');
    setMessage('');
    try {
      const pending = instance.init();
      try {
        instance.backButton.show();
      } catch (error) {
        setMessage(asErrorMessage(error));
      }
      await pending;
    } catch (error) {
      setStatus('error');
      if (error instanceof AWInitError || error instanceof AWTimeoutError) {
        setMessage(asErrorMessage(error));
      } else {
        setMessage(asErrorMessage(error));
      }
    } finally {
      setLoggingIn(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <Link className="back" to="/">
          ← Все сценарии
        </Link>
        <h1>{appName} — Донат</h1>
        <span className={`dot -${status}`}></span>
        <span className="muted"> {STATUS_LABEL[status]}</span>
      </header>

      {status !== 'ready' && (
        <section className="card">
          <p className="hint">Сначала войдите через кошелёк, затем можно отправить донат.</p>
          <button
            className="btn"
            type="button"
            disabled={!hasSdk || loggingIn || status === 'connecting'}
            onClick={() => void login()}
          >
            {loggingIn || status === 'connecting'
              ? 'Подключение…'
              : 'Войти через Antarctic Wallet'}
          </button>
        </section>
      )}

      {user && (
        <section className="card">
          <div className="user">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : null}
            <div>
              <div className="name">{user.displayName ?? 'Пользователь'}</div>
              <div className="muted">{trustedUserId ?? 'проверка…'}</div>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="label">Односторонний платёж</div>
        <p className="hint">Отправляет {DONATE_AMOUNT} USDT. Без возврата — как донат.</p>
        <button
          className="btn"
          type="button"
          disabled={status !== 'ready' || busy}
          onClick={() => void donate()}
        >
          {busy ? '…' : `Пожертвовать ${DONATE_AMOUNT} USDT`}
        </button>
      </section>

      {message ? <p className="status">{message}</p> : null}
    </div>
  );
}
