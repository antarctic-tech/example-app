/**
 * Сценарий: только вход.
 *
 * 1. appId из public/config.json (поле id).
 * 2. Кнопка «Войти» → new AWSDK(...).init().
 * 3. userContext — для UI (имя, аватар). На бэкенд не отправляем.
 * 4. POST sdk.idToken на свой сервер → доверенный userId (sub).
 *
 * Скоупы заданы в этом файле, не в config.json.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AWInitError, AWScope, AWSDK, AWTimeoutError } from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const SCOPES = [AWScope.USER_DATA] as const;

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

export function Auth() {
  const sdkRef = useRef<AWSDK | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [appName, setAppName] = useState('Загрузка...');
  const [user, setUser] = useState<AWUserContext | null>(null);
  const [trustedUserId, setTrustedUserId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
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

      instance.events.on('sdk.ready', (session: AWSession) => {
        setStatus('ready');
        setUser(session.userContext ?? null);
        const idToken = instance!.idToken ?? session.idToken;
        if (!idToken) {
          setMessage('Нет idToken — дождитесь сессии и попробуйте снова.');
          return;
        }
        void verifyIdentity(idToken)
          .then((userId) => {
            setTrustedUserId(userId);
            setMessage('Личность подтверждена на бэкенде.');
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
    }

    void prepareSdk();

    return () => {
      cancelled = true;
      instance?.destroy();
      sdkRef.current = null;
    };
  }, []);

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
      claim?: string;
      hint?: string;
    };
    if (!response.ok || !data.ok || !data.userId) {
      const parts = [data.error, data.reason, data.claim, data.hint].filter(Boolean);
      throw new Error(parts.join(' · ') || `HTTP ${response.status}`);
    }
    return data.userId;
  }

  async function login() {
    const instance = sdkRef.current;
    if (!instance || loggingIn) return;

    setLoggingIn(true);
    setStatus('connecting');
    setMessage('');
    try {
      await instance.init();
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
        <h1>{appName} — Вход</h1>
        <span className={`dot -${status}`}></span>
        <span className="muted"> {STATUS_LABEL[status]}</span>
      </header>

      {status !== 'ready' && (
        <section className="card">
          <p className="hint">
            Нажмите кнопку, чтобы начать хендшейк с кошельком. В проде внутри
            кошелька <code>init()</code> можно вызывать при открытии экрана.
          </p>
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
            </div>
          </div>
          <p className="hint">
            Профиль выше — из <code>userContext</code>, только для UI. Бэкенду ему
            нельзя доверять (IDOR).
          </p>
        </section>
      )}

      {status === 'ready' && (
        <section className="card">
          <div className="label">Доверенный userId</div>
          <div className="value">{trustedUserId ?? '—'}</div>
          <p className="hint">
            Из <code>POST /api/auth/session</code> после проверки подписанного{' '}
            <code>idToken</code>.
          </p>
        </section>
      )}

      {message ? <p className="status">{message}</p> : null}
    </div>
  );
}
