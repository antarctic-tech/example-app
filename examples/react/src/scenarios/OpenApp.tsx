/**
 * Сценарий: открыть другую мини-апку.
 *
 * sdk.openApp({ appId }).
 * Свой appId отклоняется в SDK и на хост не уходит.
 * Отказ хоста приходит как AWOpenAppError.errorCode.
 *
 * Скоуп userData нужен только для хендшейка. Самому openApp скоуп не нужен.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AWCommand,
  AWInitError,
  AWOpenAppError,
  AWScope,
  AWSDK,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const SCOPES = [AWScope.USER_DATA] as const;

type Status = 'idle' | 'connecting' | 'ready' | 'error';
type MessageTone = 'muted' | 'ok' | 'error';

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

function commandHint(supported: boolean | null): string {
  if (supported === null) return 'Доступность open_app — после входа.';
  if (supported) return 'Хост заявил open_app.';
  return 'Хост не заявил open_app. Вызов вернёт unsupported.';
}

export function OpenApp() {
  const sdkRef = useRef<AWSDK | null>(null);
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [appName, setAppName] = useState('Загрузка...');
  const [currentAppId, setCurrentAppId] = useState('');
  const [openAppSupported, setOpenAppSupported] = useState<boolean | null>(null);
  const [targetAppId, setTargetAppId] = useState('');
  const [lastCall, setLastCall] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<MessageTone>('muted');
  const [loggingIn, setLoggingIn] = useState(false);
  const [opening, setOpening] = useState(false);
  const [hasSdk, setHasSdk] = useState(false);

  function note(text: string, tone: MessageTone) {
    setMessage(text);
    setMessageTone(tone);
  }

  useEffect(() => {
    let cancelled = false;
    let instance: AWSDK | null = null;

    async function prepareSdk() {
      const config: AppConfig = await fetch('./config.json').then((r) => r.json());
      if (cancelled) return;
      setAppName(config.name);
      setCurrentAppId(config.id);

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

      instance.events.on('sdk.ready', () => {
        setStatus('ready');
        setOpenAppSupported(instance!.isCommandAvailable(AWCommand.OpenApp));
        note('', 'muted');
      });

      instance.events.on('sdk.error', ({ message: text }) => {
        setStatus('error');
        setOpenAppSupported(null);
        note(text, 'error');
      });

      instance.events.on('session.expired', () => {
        setStatus('error');
        setOpenAppSupported(null);
        note('Сессия истекла — войдите снова.', 'error');
      });

      if (cancelled) return;
      setLoggingIn(true);
      setStatus('connecting');
      try {
        const pending = instance.init();
        try {
          instance.backButton.show();
        } catch (error) {
          note(asErrorMessage(error), 'error');
        }
        await pending;
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        if (error instanceof AWInitError || error instanceof AWTimeoutError) {
          note(asErrorMessage(error), 'error');
        } else {
          note(asErrorMessage(error), 'error');
        }
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

  async function login() {
    const instance = sdkRef.current;
    if (!instance || loggingIn) return;

    setLoggingIn(true);
    setStatus('connecting');
    note('', 'muted');
    try {
      const pending = instance.init();
      try {
        instance.backButton.show();
      } catch (error) {
        note(asErrorMessage(error), 'error');
      }
      await pending;
    } catch (error) {
      setStatus('error');
      if (error instanceof AWInitError || error instanceof AWTimeoutError) {
        note(asErrorMessage(error), 'error');
      } else {
        note(asErrorMessage(error), 'error');
      }
    } finally {
      setLoggingIn(false);
    }
  }

  async function openTarget() {
    const instance = sdkRef.current;
    if (!instance || opening || status !== 'ready') return;

    const params = { appId: targetAppId };
    setLastCall(`sdk.openApp(${JSON.stringify(params, null, 2)})`);
    setOpening(true);
    note('', 'muted');
    try {
      await instance.openApp(params);
      note('Кошелёк принял вызов.', 'ok');
    } catch (error) {
      if (error instanceof AWOpenAppError) {
        note(`${error.errorCode} · ${error.message}`, 'error');
      } else if (error instanceof AWTimeoutError) {
        note(error.message, 'error');
      } else {
        note(asErrorMessage(error), 'error');
      }
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <Link className="back" to="/">
          ← Все сценарии
        </Link>
        <h1>{appName} — Открыть апку</h1>
        <span className={`dot -${status}`}></span>
        <span className="muted"> {STATUS_LABEL[status]}</span>
      </header>

      {status !== 'ready' && (
        <section className="card">
          <p className="hint">
            Сначала войдите: хендшейк нужен, чтобы кошелёк принял <code>openApp</code>.
            Скоуп <code>userData</code> — только для входа.
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

      <section className="card">
        <div className="label">Эта апка</div>
        <div className="value">{currentAppId || '—'}</div>
        <p className="hint">{commandHint(openAppSupported)}</p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void openTarget();
          }}
        >
          <label className="field">
            <span>appId</span>
            <input
              className="input"
              type="text"
              name="appId"
              value={targetAppId}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="id другой апки"
              onChange={(event) => setTargetAppId(event.target.value)}
            />
          </label>

          <button className="btn" type="submit" disabled={status !== 'ready' || opening}>
            {opening ? 'Открытие…' : 'Открыть'}
          </button>
        </form>

        {lastCall ? <pre className="call">{lastCall}</pre> : null}
        <p className="hint rules">
          Свой <code>appId</code> даёт <code>same_app</code>, и вызов на хост не уходит.
        </p>
      </section>

      {message ? <p className={`status -${messageTone}`}>{message}</p> : null}
    </div>
  );
}
