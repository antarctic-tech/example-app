/**
 * Сценарий: покупка (pay) и возврат (receive).
 *
 * Заказ в проде — на вашем бэкенде. В демо статус только в UI.
 * Скоупы заданы в этом файле.
 */
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AWInitError, AWSDK, AWTimeoutError } from '@antarctic-wallet/aw-sdk';
import type { AWSession, AWUserContext } from '@antarctic-wallet/aw-sdk';

interface AppConfig {
  id: string;
  name: string;
}

const SCOPES = ['userData', 'pay', 'receive'] as const;
const ITEM_AMOUNT = '9.00';

type Status = 'idle' | 'connecting' | 'ready' | 'error';
type OrderStatus = 'unpaid' | 'paid' | 'refunded';

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
  const nested = payload['data'] as Record<string, unknown> | undefined;
  const id =
    nested?.['operationId'] ??
    nested?.['operation_id'] ??
    payload['operationId'] ??
    payload['operation_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

@Component({
  selector: 'app-pay-refund',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <a class="back" routerLink="/">← Все сценарии</a>
        <h1>{{ appName }} — Покупка и возврат</h1>
        <span class="dot" [class.-connecting]="status === 'connecting'" [class.-ready]="status === 'ready'" [class.-error]="status === 'error'"></span>
        <span class="muted"> {{ statusLabel[status] }}</span>
      </header>

      @if (status !== 'ready') {
        <section class="card">
          <p class="hint">Сначала войдите через кошелёк, затем можно купить и вернуть товар.</p>
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
        <div class="label">Демо-товар</div>
        <div class="value">{{ itemAmount }} USDT</div>
        <p class="hint">
          В проде заказ хранится на вашем бэкенде
          @if (orderStatus) {
            — демо-статус <strong>{{ orderLabel[orderStatus] }}</strong>
          }.
        </p>
        @if (orderStatus !== 'paid' && orderStatus !== 'refunded') {
          <button
            class="btn"
            type="button"
            [disabled]="status !== 'ready' || busy"
            (click)="buy()"
          >
            {{ busy ? '…' : 'Купить' }}
          </button>
        } @else if (orderStatus === 'paid') {
          <button
            class="btn -ghost"
            type="button"
            [disabled]="busy"
            (click)="refund()"
          >
            {{ busy ? '…' : 'Вернуть' }}
          </button>
        } @else {
          <p class="hint">Заказ возвращён.</p>
        }
      </section>

      @if (message) {
        <p class="status">{{ message }}</p>
      }
    </div>
  `,
})
export class PayRefundComponent implements OnInit, OnDestroy {
  readonly statusLabel = STATUS_LABEL;
  readonly orderLabel = ORDER_LABEL;
  readonly itemAmount = ITEM_AMOUNT;
  status: Status = 'idle';
  appName = 'Загрузка...';
  user: AWUserContext | null = null;
  trustedUserId: string | null = null;
  message = '';
  loggingIn = false;
  busy = false;
  orderStatus: OrderStatus | null = null;
  sdk: AWSDK | null = null;
  private session: AWSession | null = null;

  constructor(private readonly cdr: ChangeDetectorRef) {}

  ngOnInit() {
    void this.prepareSdk();
  }

  ngOnDestroy() {
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
      await instance.init();
    } catch (error) {
      this.status = 'error';
      if (error instanceof AWInitError || error instanceof AWTimeoutError) {
        this.message = asErrorMessage(error);
      } else {
        this.message = asErrorMessage(error);
      }
    } finally {
      this.loggingIn = false;
    }
  }

  async buy() {
    const instance = this.sdk;
    if (!instance || !this.currentIdToken()) {
      this.message = 'Сначала войдите через кошелёк.';
      return;
    }
    this.busy = true;
    this.message = 'Создаём pay-интент…';
    try {
      const operationId = await this.createIntent('pay', ITEM_AMOUNT);
      this.orderStatus = 'unpaid';
      this.message = 'Подтвердите оплату в кошельке…';
      const result = await instance.operations.requestConfirmation(operationId);
      if (result.status !== 'confirmed') {
        this.message = `Оплата: ${result.status}`;
        return;
      }
      this.orderStatus = 'paid';
      this.message = 'Оплачено. Можно вернуть.';
    } catch (error) {
      this.message = asErrorMessage(error);
    } finally {
      this.busy = false;
    }
  }

  async refund() {
    const instance = this.sdk;
    if (!instance || !this.currentIdToken()) return;
    this.busy = true;
    this.message = 'Создаём receive-интент…';
    try {
      const operationId = await this.createIntent('receive', ITEM_AMOUNT);
      this.message = 'Подтвердите возврат в кошельке…';
      const result = await instance.operations.requestConfirmation(operationId);
      if (result.status !== 'confirmed') {
        this.message = `Возврат: ${result.status}`;
        return;
      }
      this.orderStatus = 'refunded';
      this.message = 'Возвращено.';
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

  private async createIntent(type: 'pay' | 'receive', amount: string): Promise<string> {
    const idToken = this.currentIdToken();
    if (!idToken) throw new Error('Нет idToken — нельзя создать интент');
    const response = await fetch('/api/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, type, amount }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      //
    }
    if (!response.ok) {
      throw new Error((parsed['error'] as string | undefined) ?? `HTTP ${response.status}: ${text}`);
    }
    const operationId = readOperationId(parsed);
    if (!operationId) throw new Error(`В ответе нет operationId: ${text}`);
    return operationId;
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
          this.message = 'Вход выполнен. Купите демо-товар, затем верните его.';
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
  }
}
