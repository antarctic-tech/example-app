/**
 * Сценарий: выбор скоупов, затем вход и оплата с возвратом.
 *
 * Чекбоксы по умолчанию пустые. «Войти» создаёт SDK с отмеченным набором:
 * скоупы хендшейка фиксируются в конструкторе. После входа новые скоупы
 * добираются интентом type: "scopes". Уже выданный скоуп снять нельзя:
 * удалить скоупы можно только удалением всего приложения.
 * receive — тип интента и не требует никакого скоупа.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AWInitError,
  AWOperationError,
  AWScope,
  AWScopeError,
  AWSDK,
  AWTimeoutError,
} from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const GRANTABLE_SCOPES = [AWScope.USER_DATA, AWScope.BALANCE, AWScope.PAY] as const;
const AMOUNT = '0.10';

type Status = 'idle' | 'connecting' | 'ready' | 'error';
type OrderStatus = 'unpaid' | 'paid' | 'refunded';
type GrantableScope = (typeof GRANTABLE_SCOPES)[number];

const STATUS_LABEL: Record<Status, string> = {
  idle: 'ожидание',
  connecting: 'подключение',
  ready: 'готово',
  error: 'ошибка',
};

const ORDER_LABEL: Record<OrderStatus, string> = {
  unpaid: 'не оплачен',
  paid: 'оплачен',
  refunded: 'возвращён',
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

function normalizeGranted(scopes: string[]): string[] {
  return scopes.filter((scope) => (GRANTABLE_SCOPES as readonly string[]).includes(scope));
}

function formatMoney(amount: number, scale: number): string {
  const negative = amount < 0;
  const digits = String(Math.abs(Math.trunc(amount))).padStart(Math.max(scale, 0) + 1, '0');
  const body = scale <= 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${body}` : body;
}

function formatScopeData(data: unknown): string {
  if (!Array.isArray(data)) return JSON.stringify(data) ?? 'нет данных';
  const lines: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') return JSON.stringify(data) ?? 'нет данных';
    const row = item as Record<string, unknown>;
    const available = row.available as Record<string, unknown> | undefined;
    if (
      typeof row.asset !== 'string' ||
      !available ||
      typeof available.amount !== 'number' ||
      !Number.isInteger(available.amount) ||
      typeof available.scale !== 'number' ||
      !Number.isInteger(available.scale)
    ) {
      return JSON.stringify(data) ?? 'нет данных';
    }
    lines.push(`${row.asset} ${formatMoney(available.amount, available.scale)}`);
  }
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(data) ?? 'нет данных';
}

export function Scopes() {
  const sdkRef = useRef<AWSDK | null>(null);
  const sessionRef = useRef<AWSession | null>(null);
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [appName, setAppName] = useState('Загрузка...');
  const [appId, setAppId] = useState<string | null>(null);
  const [user, setUser] = useState<AWUserContext | null>(null);
  const [trustedUserId, setTrustedUserId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [orderStatus, setOrderStatus] = useState<OrderStatus | null>(null);
  const grantedRef = useRef<string[]>([]);
  const [granted, setGranted] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [balanceText, setBalanceText] = useState('');

  function currentIdToken(): string | null {
    return sdkRef.current?.idToken ?? sessionRef.current?.idToken ?? null;
  }

  async function loadBalance() {
    const instance = sdkRef.current;
    if (!instance) return;
    try {
      setBalanceText(formatScopeData(await instance.scopes.getData()));
    } catch (error) {
      if (error instanceof AWScopeError) setBalanceText(asErrorMessage(error));
      else setBalanceText(asErrorMessage(error));
    }
  }

  function applyGranted(scopes: string[]) {
    const next = normalizeGranted(scopes);
    grantedRef.current = next;
    setGranted(next);
    setPicked((prev) => prev.filter((scope) => !next.includes(scope)));
    if (next.includes(AWScope.BALANCE)) void loadBalance();
    else setBalanceText('');
  }

  useEffect(() => {
    let cancelled = false;
    void fetch('./config.json')
      .then((r) => r.json())
      .then((config: AppConfig) => {
        if (cancelled) return;
        setAppName(config.name);
        setAppId(config.id);
      });
    return () => {
      cancelled = true;
      const current = sdkRef.current;
      try {
        current?.backButton.hide();
      } catch {
        // хост мог уже закрыть канал
      }
      current?.destroy();
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
    };
    if (!response.ok || !data.ok || !data.userId) {
      throw new Error(data.reason ?? data.error ?? `HTTP ${response.status}`);
    }
    return data.userId;
  }

  async function postIntent(
    body: Record<string, unknown>,
  ): Promise<{ operationId: string; status: string | null; failureReason: string | null }> {
    const idToken = currentIdToken();
    if (!idToken) throw new Error('Нет idToken — нельзя создать интент');
    const response = await fetch('/api/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, ...body }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      //
    }
    if (!response.ok) {
      throw new Error((parsed.error as string | undefined) ?? `HTTP ${response.status}: ${text}`);
    }
    const operationId = readOperationId(parsed);
    if (!operationId) throw new Error(`В ответе нет operationId: ${text}`);
    const intentStatus = typeof parsed.status === 'string' ? parsed.status : null;
    const failureReason =
      typeof parsed.failureReason === 'string' ? parsed.failureReason : null;
    return { operationId, status: intentStatus, failureReason };
  }

  function toggleScope(scope: GrantableScope, checked: boolean) {
    if (granted.includes(scope)) return;
    setPicked((prev) =>
      checked ? [...prev, scope] : prev.filter((item) => item !== scope),
    );
  }

  const pendingScopes = picked.filter((scope) => !granted.includes(scope));
  const payGranted = granted.includes(AWScope.PAY);

  async function updateScopes() {
    const instance = sdkRef.current;
    if (!instance || !currentIdToken() || pendingScopes.length === 0) return;
    setBusy(true);
    setMessage('Создаём scopes-интент…');
    try {
      const { operationId, status: intentStatus, failureReason } = await postIntent({
        type: 'scopes',
        scopes: pendingScopes,
      });
      if (intentStatus === 'failed') {
        setMessage(`Скоупы: ${failureReason ?? 'failed'}`);
        return;
      }
      if (intentStatus !== 'approved') {
        setMessage('Подтвердите скоупы в кошельке…');
        await instance.operations.requestConfirmation(operationId);
      }
      applyGranted(await instance.scopes.getScopes());
      setMessage('Скоупы обновлены.');
    } catch (error) {
      if (error instanceof AWOperationError || error instanceof AWScopeError) {
        setMessage(asErrorMessage(error));
      } else {
        setMessage(asErrorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    const instance = sdkRef.current;
    if (!instance || !currentIdToken() || !payGranted) {
      setMessage(
        payGranted
          ? 'Сначала войдите через кошелёк.'
          : 'Сначала включите pay и нажмите «Обновить».',
      );
      return;
    }
    setBusy(true);
    setMessage('Создаём pay-интент…');
    try {
      const { operationId, status: intentStatus, failureReason } = await postIntent({
        type: 'pay',
        amount: AMOUNT,
      });
      setOrderStatus('unpaid');
      if (intentStatus === 'failed') {
        setMessage(`Оплата: ${failureReason ?? 'failed'}`);
        return;
      }
      if (intentStatus === 'approved') {
        setOrderStatus('paid');
        setMessage('Оплачено. Можно вернуть.');
        return;
      }
      setMessage('Подтвердите оплату в кошельке…');
      const result = await instance.operations.requestConfirmation(operationId);
      if (result.status !== 'confirmed') {
        setMessage(`Оплата: ${result.status}`);
        return;
      }
      setOrderStatus('paid');
      setMessage('Оплачено. Можно вернуть.');
    } catch (error) {
      if (error instanceof AWOperationError || error instanceof AWScopeError) {
        setMessage(asErrorMessage(error));
      } else {
        setMessage(asErrorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function receive() {
    if (!currentIdToken()) return;
    setBusy(true);
    setMessage('Создаём receive-интент…');
    try {
      const { status: intentStatus, failureReason } = await postIntent({
        type: 'receive',
        amount: AMOUNT,
      });
      if (intentStatus !== 'approved') {
        setMessage(`Возврат: ${failureReason ?? intentStatus ?? 'failed'}`);
        return;
      }
      setOrderStatus('refunded');
      setMessage('Возвращено.');
    } catch (error) {
      if (error instanceof AWOperationError) setMessage(asErrorMessage(error));
      else setMessage(asErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    if (!appId || loggingIn || status === 'ready') return;

    setLoggingIn(true);
    setStatus('connecting');
    setMessage('');
    const scopes = [...picked];
    try {
      try {
        sdkRef.current?.backButton.hide();
      } catch {
        // канала ещё могло не быть
      }
      sdkRef.current?.destroy();
      const instance = new AWSDK({
        appId,
        scopes,
        parentOrigin: getParentOrigin(),
        persistSession: false,
      });
      sdkRef.current = instance;

      instance.backButton.onClick(() => {
        navigate('/');
      });
      instance.events.on('sdk.ready', (s: AWSession) => {
        setStatus('ready');
        sessionRef.current = s;
        setUser(s.userContext ?? null);
        const idToken = instance.idToken ?? s.idToken;
        if (!idToken) {
          setMessage('Нет idToken.');
          return;
        }
        const grantedNow = normalizeGranted(s.grantedScopes ?? []);
        const stillPending = scopes.some((scope) => !grantedNow.includes(scope));
        void verifyIdentity(idToken)
          .then((userId) => {
            setTrustedUserId(userId);
            setMessage(
              stillPending
                ? 'Вход выполнен. Нажмите «Обновить», чтобы запросить новые скоупы.'
                : 'Вход выполнен.',
            );
          })
          .catch((error: unknown) => {
            setMessage(asErrorMessage(error));
          });
      });
      instance.events.on('scopes.granted', ({ scopes: grantedScopes }) => {
        applyGranted(grantedScopes);
      });
      instance.events.on('sdk.error', ({ message: text }) => {
        setStatus('error');
        setMessage(text);
      });
      instance.events.on('session.expired', () => {
        setStatus('error');
        setUser(null);
        setTrustedUserId(null);
        setPicked((prev) => [...new Set([...prev, ...grantedRef.current])]);
        grantedRef.current = [];
        setGranted([]);
        setBalanceText('');
        setOrderStatus(null);
        setMessage('Сессия истекла — войдите снова.');
      });
      instance.events.on('operation.rejected', ({ reason }) => {
        setMessage(`Отклонено: ${reason}`);
      });

      const pending = instance.init();
      try {
        instance.backButton.show();
      } catch (error) {
        setMessage(asErrorMessage(error));
      }
      await pending;
    } catch (error) {
      setStatus('error');
      if (
        error instanceof AWInitError ||
        error instanceof AWTimeoutError ||
        error instanceof AWScopeError
      ) {
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
        <h1>{appName} — Скоупы</h1>
        <span className={`dot -${status}`}></span>
        <span className="muted"> {STATUS_LABEL[status]}</span>
      </header>

      <section className="card">
        <div className="label">Скоупы</div>
        <p className="hint">
          Отметьте нужные скоупы и нажмите «Войти». После входа новые отмечаются здесь и
          подключаются кнопкой «Обновить». Уже выданный скоуп снять нельзя: удалить
          скоупы можно только удалением всего приложения.
        </p>
        {GRANTABLE_SCOPES.map((scope) => {
          const active = granted.includes(scope);
          return (
            <label key={scope} className={`scope${active ? ' -active' : ''}`}>
              <input
                type="checkbox"
                checked={active || picked.includes(scope)}
                disabled={active || busy || loggingIn}
                onChange={(event) => toggleScope(scope, event.target.checked)}
              />
              <span>
                <span className="scope-name">{scope}</span>
                {active ? <span className="scope-note">активен</span> : null}
              </span>
            </label>
          );
        })}
        <button
          className="btn"
          type="button"
          disabled={status !== 'ready' || busy || pendingScopes.length === 0}
          onClick={() => void updateScopes()}
        >
          {busy ? '…' : 'Обновить'}
        </button>
      </section>

      {status !== 'ready' && (
        <section className="card">
          <div className="label">Вход</div>
          <p className="hint">Вход запросит скоупы, отмеченные выше.</p>
          <button
            className="btn"
            type="button"
            disabled={!appId || loggingIn || status === 'connecting'}
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
          <div className="label">Авторизация</div>
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
        <div className="label">Баланс</div>
        {granted.includes(AWScope.BALANCE) ? (
          <p className="value balance">{balanceText || 'загрузка…'}</p>
        ) : (
          <p className="hint">Включите balance и нажмите «Обновить».</p>
        )}
      </section>

      <section className="card">
        <div className="label">Оплата и возврат</div>
        <div className="value">{AMOUNT} USDT</div>
        <p className="hint">
          Оплата доступна после скоупа pay. Возврат — после оплаты, скоуп для него не нужен
          {orderStatus ? (
            <>
              {' '}
              — демо-статус <strong>{ORDER_LABEL[orderStatus]}</strong>
            </>
          ) : null}
          .
        </p>
        {orderStatus !== 'paid' && orderStatus !== 'refunded' ? (
          <button
            className="btn"
            type="button"
            disabled={status !== 'ready' || busy || !payGranted}
            onClick={() => void pay()}
          >
            {busy ? '…' : 'Оплатить'}
          </button>
        ) : orderStatus === 'paid' ? (
          <button className="btn -ghost" type="button" disabled={busy} onClick={() => void receive()}>
            {busy ? '…' : 'Вернуть'}
          </button>
        ) : (
          <p className="hint">Заказ возвращён.</p>
        )}
      </section>

      {message ? <p className="status">{message}</p> : null}
    </div>
  );
}
