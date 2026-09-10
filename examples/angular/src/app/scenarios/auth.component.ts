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
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
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

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <a class="back" routerLink="/">← Все сценарии</a>
        <h1>{{ appName }} — Вход</h1>
        <span class="dot" [class.-connecting]="status === 'connecting'" [class.-ready]="status === 'ready'" [class.-error]="status === 'error'"></span>
        <span class="muted"> {{ statusLabel[status] }}</span>
      </header>

      @if (status !== 'ready') {
        <section class="card">
          <p class="hint">
            Нажмите кнопку, чтобы начать хендшейк с кошельком. В проде внутри
            кошелька <code>init()</code> можно вызывать при открытии экрана.
          </p>
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
            </div>
          </div>
          <p class="hint">
            Профиль выше — из <code>userContext</code>, только для UI. Бэкенду ему
            нельзя доверять (IDOR).
          </p>
        </section>
      }

      @if (status === 'ready') {
        <section class="card">
          <div class="label">Доверенный userId</div>
          <div class="value">{{ trustedUserId ?? '—' }}</div>
          <p class="hint">
            Из <code>POST /api/auth/session</code> после проверки подписанного
            <code>idToken</code>.
          </p>
        </section>
      }

      @if (message) {
        <p class="status">{{ message }}</p>
      }
    </div>
  `,
})
export class AuthComponent implements OnInit, OnDestroy {
  readonly statusLabel = STATUS_LABEL;
  status: Status = 'idle';
  appName = 'Загрузка...';
  user: AWUserContext | null = null;
  trustedUserId: string | null = null;
  message = '';
  loggingIn = false;
  sdk: AWSDK | null = null;

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
      claim?: string;
      hint?: string;
    };
    if (!response.ok || !data.ok || !data.userId) {
      const parts = [data.error, data.reason, data.claim, data.hint].filter(Boolean);
      throw new Error(parts.join(' · ') || `HTTP ${response.status}`);
    }
    this.trustedUserId = data.userId;
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

    instance.events.on('sdk.ready', (session: AWSession) => {
      this.status = 'ready';
      this.user = session.userContext ?? null;
      const idToken = instance.idToken ?? session.idToken;
      if (!idToken) {
        this.message = 'Нет idToken — дождитесь сессии и попробуйте снова.';
        this.cdr.detectChanges();
        return;
      }
      void this.verifyIdentity(idToken)
        .then(() => {
          this.message = 'Личность подтверждена на бэкенде.';
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

    this.cdr.detectChanges();
  }
}
