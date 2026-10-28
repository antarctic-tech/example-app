/**
 * Сценарий: выбор скоупов, затем вход и оплата с возвратом.
 *
 * Чекбоксы по умолчанию пустые. «Войти» создаёт SDK с отмеченным набором:
 * скоупы хендшейка фиксируются в конструкторе. После входа новые скоупы
 * добираются интентом type: "scopes". Уже выданный скоуп снять нельзя:
 * удалить скоупы можно только удалением всего приложения.
 * receive — тип интента и не требует никакого скоупа.
 */
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
    const available = row['available'] as Record<string, unknown> | undefined;
    if (
      typeof row['asset'] !== 'string' ||
      !available ||
      typeof available['amount'] !== 'number' ||
      !Number.isInteger(available['amount']) ||
      typeof available['scale'] !== 'number' ||
      !Number.isInteger(available['scale'])
    ) {
      return JSON.stringify(data) ?? 'нет данных';
    }
    lines.push(`${row['asset']} ${formatMoney(available['amount'], available['scale'])}`);
  }
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(data) ?? 'нет данных';
}

@Component({
  selector: 'app-scopes',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <a class="back" routerLink="/">← Все сценарии</a>
        <h1>{{ appName }} — Скоупы</h1>
        <span class="dot" [class.-connecting]="status === 'connecting'" [class.-ready]="status === 'ready'" [class.-error]="status === 'error'"></span>
        <span class="muted"> {{ statusLabel[status] }}</span>
      </header>

      <section class="card">
        <div class="label">Скоупы</div>
        <p class="hint">Отметьте нужные скоупы и нажмите «Войти». После входа новые отмечаются здесь и подключаются кнопкой «Обновить». Уже выданный скоуп снять нельзя: удалить скоупы можно только удалением всего приложения.</p>
        @for (scope of grantableScopes; track scope) {
          <label class="scope" [class.-active]="isGranted(scope)">
            <input
              type="checkbox"
              [checked]="isGranted(scope) || isPicked(scope)"
              [disabled]="isGranted(scope) || busy || loggingIn"
              (change)="onScopeChange(scope, $event)"
            />
            <span>
              <span class="scope-name">{{ scope }}</span>
              @if (isGranted(scope)) {
                <span class="scope-note">активен</span>
              }
            </span>
          </label>
        }
        <button
          class="btn"
          type="button"
          [disabled]="status !== 'ready' || busy || pendingScopes.length === 0"
          (click)="updateScopes()"
        >
          {{ busy ? '…' : 'Обновить' }}
        </button>
      </section>

      @if (status !== 'ready') {
        <section class="card">
          <div class="label">Вход</div>
          <p class="hint">Вход запросит скоупы, отмеченные выше.</p>
          <button
            class="btn"
            type="button"
            [disabled]="!appId || loggingIn || status === 'connecting'"
            (click)="login()"
          >
            {{ loggingIn || status === 'connecting' ? 'Подключение…' : 'Войти через Antarctic Wallet' }}
          </button>
        </section>
      }

      @if (user) {
        <section class="card">
          <div class="label">Авторизация</div>
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
        <div class="label">Баланс</div>
        @if (isGranted(balanceScope)) {
          <p class="value balance">{{ balanceText || 'загрузка…' }}</p>
        } @else {
          <p class="hint">Включите balance и нажмите «Обновить».</p>
        }
      </section>

      <section class="card">
        <div class="label">Оплата и возврат</div>
        <div class="value">{{ amount }} USDT</div>
        <p class="hint">
          Оплата доступна после скоупа pay. Возврат — после оплаты, скоуп для него не нужен
          @if (orderStatus) {
            — демо-статус <strong>{{ orderLabel[orderStatus] }}</strong>
          }.
        </p>
        @if (orderStatus !== 'paid' && orderStatus !== 'refunded') {
          <button
            class="btn"
            type="button"
            [disabled]="status !== 'ready' || busy || !payGranted"
            (click)="pay()"
          >
            {{ busy ? '…' : 'Оплатить' }}
          </button>
        } @else if (orderStatus === 'paid') {
          <button class="btn -ghost" type="button" [disabled]="busy" (click)="receive()">
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
export class ScopesComponent implements OnInit, OnDestroy {
  readonly statusLabel = STATUS_LABEL;
  readonly orderLabel = ORDER_LABEL;
  readonly grantableScopes = GRANTABLE_SCOPES;
  readonly balanceScope = AWScope.BALANCE;
  readonly amount = AMOUNT;
  status: Status = 'idle';
  appName = 'Загрузка...';
  appId: string | null = null;
  user: AWUserContext | null = null;
  trustedUserId: string | null = null;
  message = '';
  loggingIn = false;
  busy = false;
  orderStatus: OrderStatus | null = null;
  granted: string[] = [];
  picked: string[] = [];
  balanceText = '';
  sdk: AWSDK | null = null;
  private session: AWSession | null = null;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly router: Router,
  ) {}

  get pendingScopes(): string[] {
    return this.picked.filter((scope) => !this.granted.includes(scope));
  }

  get payGranted(): boolean {
    return this.granted.includes(AWScope.PAY);
  }

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

  isGranted(scope: string): boolean {
    return this.granted.includes(scope);
  }

  isPicked(scope: string): boolean {
    return this.picked.includes(scope);
  }

  onScopeChange(scope: string, event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    if (this.isGranted(scope)) return;
    this.picked = checked
      ? [...this.picked, scope]
      : this.picked.filter((item) => item !== scope);
  }

  async login() {
    const id = this.appId;
    if (!id || this.loggingIn || this.status === 'ready') return;

    this.loggingIn = true;
    this.status = 'connecting';
    this.message = '';
    const scopes = [...this.picked];
    try {
      try {
        this.sdk?.backButton.hide();
      } catch {
        // канала ещё могло не быть
      }
      this.sdk?.destroy();
      const instance = new AWSDK({
        appId: id,
        scopes,
        parentOrigin: getParentOrigin(),
        persistSession: false,
      });
      this.sdk = instance;
      this.bindSdk(instance, scopes);
      const pending = instance.init();
      try {
        instance.backButton.show();
      } catch (error) {
        this.message = asErrorMessage(error);
      }
      await pending;
    } catch (error) {
      this.status = 'error';
      if (
        error instanceof AWInitError ||
        error instanceof AWTimeoutError ||
        error instanceof AWScopeError
      ) {
        this.message = asErrorMessage(error);
      } else {
        this.message = asErrorMessage(error);
      }
    } finally {
      this.loggingIn = false;
      this.cdr.detectChanges();
    }
  }

  async updateScopes() {
    const instance = this.sdk;
    const scopes = this.pendingScopes;
    if (!instance || !this.currentIdToken() || scopes.length === 0) return;
    this.busy = true;
    this.message = 'Создаём scopes-интент…';
    try {
      const { operationId, status: intentStatus, failureReason } = await this.postIntent({
        type: 'scopes',
        scopes,
      });
      if (intentStatus === 'failed') {
        this.message = `Скоупы: ${failureReason ?? 'failed'}`;
        return;
      }
      if (intentStatus !== 'approved') {
        this.message = 'Подтвердите скоупы в кошельке…';
        await instance.operations.requestConfirmation(operationId);
      }
      await this.refreshGranted();
      this.message = 'Скоупы обновлены.';
    } catch (error) {
      if (error instanceof AWOperationError || error instanceof AWScopeError) {
        this.message = asErrorMessage(error);
      } else {
        this.message = asErrorMessage(error);
      }
    } finally {
      this.busy = false;
      this.cdr.detectChanges();
    }
  }

  async pay() {
    const instance = this.sdk;
    if (!instance || !this.currentIdToken() || !this.payGranted) {
      this.message = this.payGranted
        ? 'Сначала войдите через кошелёк.'
        : 'Сначала включите pay и нажмите «Обновить».';
      return;
    }
    this.busy = true;
    this.message = 'Создаём pay-интент…';
    try {
      const { operationId, status: intentStatus, failureReason } = await this.postIntent({
        type: 'pay',
        amount: AMOUNT,
      });
      this.orderStatus = 'unpaid';
      if (intentStatus === 'failed') {
        this.message = `Оплата: ${failureReason ?? 'failed'}`;
        return;
      }
      if (intentStatus === 'approved') {
        this.orderStatus = 'paid';
        this.message = 'Оплачено. Можно вернуть.';
        return;
      }
      this.message = 'Подтвердите оплату в кошельке…';
      const result = await instance.operations.requestConfirmation(operationId);
      if (result.status !== 'confirmed') {
        this.message = `Оплата: ${result.status}`;
        return;
      }
      this.orderStatus = 'paid';
      this.message = 'Оплачено. Можно вернуть.';
    } catch (error) {
      if (error instanceof AWOperationError || error instanceof AWScopeError) {
        this.message = asErrorMessage(error);
      } else {
        this.message = asErrorMessage(error);
      }
    } finally {
      this.busy = false;
      this.cdr.detectChanges();
    }
  }

  async receive() {
    if (!this.currentIdToken()) return;
    this.busy = true;
    this.message = 'Создаём receive-интент…';
    try {
      const { status: intentStatus, failureReason } = await this.postIntent({
        type: 'receive',
        amount: AMOUNT,
      });
      if (intentStatus !== 'approved') {
        this.message = `Возврат: ${failureReason ?? intentStatus ?? 'failed'}`;
        return;
      }
      this.orderStatus = 'refunded';
      this.message = 'Возвращено.';
    } catch (error) {
      if (error instanceof AWOperationError) this.message = asErrorMessage(error);
      else this.message = asErrorMessage(error);
    } finally {
      this.busy = false;
      this.cdr.detectChanges();
    }
  }

  private currentIdToken(): string | null {
    return this.sdk?.idToken ?? this.session?.idToken ?? null;
  }

  private applyGranted(scopes: string[]) {
    const next = normalizeGranted(scopes);
    this.granted = next;
    this.picked = this.picked.filter((scope) => !next.includes(scope));
    if (next.includes(AWScope.BALANCE)) void this.loadBalance();
    else this.balanceText = '';
    this.cdr.detectChanges();
  }

  private async loadBalance() {
    const instance = this.sdk;
    if (!instance) return;
    try {
      this.balanceText = formatScopeData(await instance.scopes.getData());
    } catch (error) {
      if (error instanceof AWScopeError) this.balanceText = asErrorMessage(error);
      else this.balanceText = asErrorMessage(error);
    }
    this.cdr.detectChanges();
  }

  private async refreshGranted() {
    const instance = this.sdk;
    if (!instance) return;
    this.applyGranted(await instance.scopes.getScopes());
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

  private async postIntent(
    body: Record<string, unknown>,
  ): Promise<{ operationId: string; status: string | null; failureReason: string | null }> {
    const idToken = this.currentIdToken();
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
      throw new Error((parsed['error'] as string | undefined) ?? `HTTP ${response.status}: ${text}`);
    }
    const operationId = readOperationId(parsed);
    if (!operationId) throw new Error(`В ответе нет operationId: ${text}`);
    const intentStatus = typeof parsed['status'] === 'string' ? parsed['status'] : null;
    const failureReason =
      typeof parsed['failureReason'] === 'string' ? parsed['failureReason'] : null;
    return { operationId, status: intentStatus, failureReason };
  }

  private async prepareSdk() {
    const config: AppConfig = await fetch('./config.json').then((r) => r.json());
    this.appName = config.name;
    this.appId = config.id;
    this.cdr.detectChanges();
  }

  private bindSdk(instance: AWSDK, requested: string[]) {
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
      const grantedNow = normalizeGranted(s.grantedScopes ?? []);
      const stillPending = requested.some((scope) => !grantedNow.includes(scope));
      void this.verifyIdentity(idToken)
        .then(() => {
          this.message = stillPending
            ? 'Вход выполнен. Нажмите «Обновить», чтобы запросить новые скоупы.'
            : 'Вход выполнен.';
          this.cdr.detectChanges();
        })
        .catch((error: unknown) => {
          this.message = asErrorMessage(error);
          this.cdr.detectChanges();
        });
      this.cdr.detectChanges();
    });

    instance.events.on('scopes.granted', ({ scopes }) => {
      this.applyGranted(scopes);
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
      this.picked = [...new Set([...this.picked, ...this.granted])];
      this.granted = [];
      this.balanceText = '';
      this.orderStatus = null;
      this.message = 'Сессия истекла — войдите снова.';
      this.cdr.detectChanges();
    });

    instance.events.on('operation.rejected', ({ reason }) => {
      this.message = `Отклонено: ${reason}`;
      this.cdr.detectChanges();
    });
  }
}
