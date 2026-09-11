/**
 * Сценарий: вход + односторонний платёж (донат).
 *
 * После входа ваш бэкенд создаёт интент pay через POST /api/intents.
 * Возврата нет. Скоупы заданы в этом файле.
 */
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
  const nested = payload['data'] as Record<string, unknown> | undefined;
  const id =
    nested?.['operationId'] ??
    nested?.['operation_id'] ??
    payload['operationId'] ??
    payload['operation_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

@Component({
  selector: 'app-pay',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <a class="back" routerLink="/">← Все сценарии</a>
        <h1>{{ appName }} — Донат</h1>
        <span class="dot" [class.-connecting]="status === 'connecting'" [class.-ready]="status === 'ready'" [class.-error]="status === 'error'"></span>
        <span class="muted"> {{ statusLabel[status] }}</span>
      </header>

      @if (status !== 'ready') {
        <section class="card">
          <p class="hint">Сначала войдите через кошелёк, затем можно отправить донат.</p>
          <button
            class="btn"
            type="button"
            [disabled]="!sdk || loggingIn || status === 'connecting'"
            (click)="login()"
          >
            {{ loggingIn || status === 'connecting' ? 'Подключение…' : 'Войти через Antarctic Wallet' }}
          </button>
        </section>
      }

      @if (user) {
        <section class="card">
          <div class="user">
            @if (user.avatarUrl) {
              <img [src]="user.avatarUrl" alt="" />
            }
            <div>
              <div class="name">{{ user.displayName ?? 'Пользователь' }}</div>
              <div class="muted">{{ trustedUserId ?? 'проверка…' }}</div>
            </div>
          </div>
        </section>
      }

      <section class="card">
        <div class="label">Односторонний платёж</div>
        <p class="hint">Отправляет {{ donateAmount }} USDT. Без возврата — как донат.</p>
        <button
          class="btn"
          type="button"
          [disabled]="status !== 'ready' || busy"
          (click)="donate()"
        >
          {{ busy ? '…' : 'Пожертвовать ' + donateAmount + ' USDT' }}
        </button>
      </section>

      @if (message) {
        <p class="status">{{ message }}</p>
      }
    </div>
  `,
})
export class PayComponent implements OnInit, OnDestroy {
  readonly statusLabel = STATUS_LABEL;
  readonly donateAmount = DONATE_AMOUNT;
  status: Status = 'idle';
  appName = 'Загрузка...';
  user: AWUserContext | null = null;
  trustedUserId: string | null = null;
  message = '';
  loggingIn = false;
  busy = false;
  sdk: AWSDK | null = null;
  private session: AWSession | null = null;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly router: Router,
  ) {}

  ngOnInit() {
    void this.prepareSdk();
  }

  ngOnDestroy() {
    try {
      this.sdk?.backButton.hide();
    } catch {
      // хост мог уже закрыть канал
    }
    this.sdk?.destroy();
    this.sdk = null;
  }

  async login() {
    const instance = this.sdk;
    if (!instance || this.loggingIn) return;

    this.loggingIn = true;
    this.status = 'connecting';
    this.message = '';
    try {
      const pending = instance.init();
      try {
        instance.backButton.show();
      } catch (error) {
        this.message = asErrorMessage(error);
      }
      await pending;
    } catch (error) {
      this.status = 'error';
      if (error instanceof AWInitError || error instanceof AWTimeoutError) {
        this.message = asErrorMessage(error);
      } else {
        this.message = asErrorMessage(error);
      }
    } finally {
      this.loggingIn = false;
      this.cdr.detectChanges();
    }
  }

  async donate() {
    const instance = this.sdk;
    if (!instance || !this.currentIdToken()) {
      this.message = 'Сначала войдите через кошелёк.';
      return;
    }
    this.busy = true;
    this.message = 'Создаём pay-интент…';
    try {
      const { operationId, status: intentStatus, failureReason } =
        await this.createPayIntent(DONATE_AMOUNT);
      if (intentStatus === 'failed') {
        this.message = `Донат: ${failureReason ?? 'failed'}`;
        return;
      }
      if (intentStatus === 'approved') {
        this.message = 'Донат: approved';
        return;
      }
      this.message = 'Подтвердите в кошельке…';
      const result = await instance.operations.requestConfirmation(operationId);
      this.message = `Донат: ${result.status}${result.txId ? ` · ${result.txId}` : ''}`;
    } catch (error) {
      this.message = asErrorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  private currentIdToken(): string | null {
    return this.sdk?.idToken ?? this.session?.idToken ?? null;
  }

  private async verifyIdentity(idToken: string) {
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
    this.trustedUserId = data.userId;
  }

  private async createPayIntent(amount: string): Promise<{
    operationId: string;
    status: string | null;
    failureReason: string | null;
  }> {
    const idToken = this.currentIdToken();
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
        (parsed['error'] as string | undefined) ?? `HTTP ${response.status}: ${text}`,
      );
    }
    const operationId = readOperationId(parsed);
    if (!operationId) throw new Error(`В ответе нет operationId: ${text}`);
    const status = typeof parsed['status'] === 'string' ? parsed['status'] : null;
    const failureReason =
      typeof parsed['failureReason'] === 'string' ? parsed['failureReason'] : null;
    return { operationId, status, failureReason };
  }

  private async prepareSdk() {
    const config: AppConfig = await fetch('./config.json').then((r) => r.json());
    this.appName = config.name;

    const instance = new AWSDK({
      appId: config.id,
      scopes: [...SCOPES],
      parentOrigin: getParentOrigin(),
      persistSession: true,
    });
    this.sdk = instance;

    instance.backButton.onClick(() => {
      void this.router.navigateByUrl('/');
    });

    instance.events.on('sdk.ready', (s: AWSession) => {
      this.status = 'ready';
      this.session = s;
      this.user = s.userContext ?? null;
      const idToken = instance.idToken ?? s.idToken;
      if (!idToken) {
        this.message = 'Нет idToken.';
        this.cdr.detectChanges();
        return;
      }
      void this.verifyIdentity(idToken)
        .then(() => {
          this.message = 'Вход выполнен. Можно отправить донат.';
          this.cdr.detectChanges();
        })
        .catch((error: unknown) => {
          this.message = asErrorMessage(error);
          this.cdr.detectChanges();
        });
      this.cdr.detectChanges();
    });

    instance.events.on('sdk.error', ({ message: text }) => {
      this.status = 'error';
      this.message = text;
      this.cdr.detectChanges();
    });

    instance.events.on('session.expired', () => {
      this.status = 'error';
      this.user = null;
      this.trustedUserId = null;
      this.message = 'Сессия истекла — войдите снова.';
      this.cdr.detectChanges();
    });

    instance.events.on('operation.rejected', ({ reason }) => {
      this.message = `Отклонено: ${reason}`;
      this.cdr.detectChanges();
    });

    this.cdr.detectChanges();
    void this.login();
  }
}
