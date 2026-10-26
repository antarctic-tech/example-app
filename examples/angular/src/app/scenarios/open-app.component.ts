/**
 * Сценарий: открыть другую мини-апку.
 *
 * sdk.openApp({ appId }).
 * Свой appId отклоняется в SDK и на хост не уходит.
 * Отказ хоста приходит как AWOpenAppError.errorCode.
 *
 * Скоуп userData нужен только для хендшейка. Самому openApp скоуп не нужен.
 */
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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

@Component({
  selector: 'app-open-app',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <a class="back" routerLink="/">← Все сценарии</a>
        <h1>{{ appName }} — Открыть апку</h1>
        <span class="dot" [class.-connecting]="status === 'connecting'" [class.-ready]="status === 'ready'" [class.-error]="status === 'error'"></span>
        <span class="muted"> {{ statusLabel[status] }}</span>
      </header>

      @if (status !== 'ready') {
        <section class="card">
          <p class="hint">
            Сначала войдите: хендшейк нужен, чтобы кошелёк принял <code>openApp</code>.
            Скоуп <code>userData</code> — только для входа.
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

      <section class="card">
        <div class="label">Эта апка</div>
        <div class="value">{{ currentAppId || '—' }}</div>
        <p class="hint">{{ commandHint }}</p>

        <form (submit)="openTarget($event)">
          <label class="field">
            <span>appId</span>
            <input
              class="input"
              type="text"
              name="appId"
              [value]="targetAppId"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="id другой апки"
              (input)="targetAppId = inputValue($event)"
            />
          </label>

          <button class="btn" type="submit" [disabled]="status !== 'ready' || opening">
            {{ opening ? 'Открытие…' : 'Открыть' }}
          </button>
        </form>

        @if (lastCall) {
          <pre class="call">{{ lastCall }}</pre>
        }
        <p class="hint rules">
          Свой <code>appId</code> даёт <code>same_app</code>, и вызов на хост не уходит.
        </p>
      </section>

      @if (message) {
        <p class="status" [class.-ok]="messageTone === 'ok'" [class.-error]="messageTone === 'error'">{{ message }}</p>
      }
    </div>
  `,
})
export class OpenAppComponent implements OnInit, OnDestroy {
  readonly statusLabel = STATUS_LABEL;
  status: Status = 'idle';
  appName = 'Загрузка...';
  currentAppId = '';
  openAppSupported: boolean | null = null;
  targetAppId = '';
  lastCall = '';
  message = '';
  messageTone: MessageTone = 'muted';
  loggingIn = false;
  opening = false;
  sdk: AWSDK | null = null;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly router: Router,
  ) {}

  get commandHint(): string {
    if (this.openAppSupported === null) return 'Доступность open_app — после входа.';
    if (this.openAppSupported) return 'Хост заявил open_app.';
    return 'Хост не заявил open_app. Вызов вернёт unsupported.';
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

  inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  async login() {
    const instance = this.sdk;
    if (!instance || this.loggingIn) return;

    this.loggingIn = true;
    this.status = 'connecting';
    this.note('', 'muted');
    try {
      const pending = instance.init();
      try {
        instance.backButton.show();
      } catch (error) {
        this.note(asErrorMessage(error), 'error');
      }
      await pending;
    } catch (error) {
      this.status = 'error';
      if (error instanceof AWInitError || error instanceof AWTimeoutError) {
        this.note(asErrorMessage(error), 'error');
      } else {
        this.note(asErrorMessage(error), 'error');
      }
    } finally {
      this.loggingIn = false;
      this.cdr.detectChanges();
    }
  }

  async openTarget(event: Event) {
    event.preventDefault();
    const instance = this.sdk;
    if (!instance || this.opening || this.status !== 'ready') return;

    const params = { appId: this.targetAppId };
    this.lastCall = `sdk.openApp(${JSON.stringify(params, null, 2)})`;
    this.opening = true;
    this.note('', 'muted');
    try {
      await instance.openApp(params);
      this.note('Кошелёк принял вызов.', 'ok');
    } catch (error) {
      if (error instanceof AWOpenAppError) {
        this.note(`${error.errorCode} · ${error.message}`, 'error');
      } else if (error instanceof AWTimeoutError) {
        this.note(error.message, 'error');
      } else {
        this.note(asErrorMessage(error), 'error');
      }
    } finally {
      this.opening = false;
      this.cdr.detectChanges();
    }
  }

  private note(text: string, tone: MessageTone) {
    this.message = text;
    this.messageTone = tone;
    this.cdr.detectChanges();
  }

  private async prepareSdk() {
    const config: AppConfig = await fetch('./config.json').then((r) => r.json());
    this.appName = config.name;
    this.currentAppId = config.id;

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

    instance.events.on('sdk.ready', () => {
      this.status = 'ready';
      this.openAppSupported = instance.isCommandAvailable(AWCommand.OpenApp);
      this.note('', 'muted');
    });

    instance.events.on('sdk.error', ({ message: text }) => {
      this.status = 'error';
      this.openAppSupported = null;
      this.note(text, 'error');
    });

    instance.events.on('session.expired', () => {
      this.status = 'error';
      this.openAppSupported = null;
      this.note('Сессия истекла — войдите снова.', 'error');
    });

    this.cdr.detectChanges();
    void this.login();
  }
}
