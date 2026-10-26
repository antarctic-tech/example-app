import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AWScope, AWSDK } from '@antarctic-wallet/aw-sdk';

/**
 * Параметр этого открытия iframe. Повторный заход на экран его не перечитывает:
 * refreshSession() его не меняет, а новый хендшейк только мешал бы сценариям.
 */
let cachedStartParam: string | null | undefined;

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

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <h1 class="home-title">{{ appName }}</h1>
        <p class="start-param">
          start_param:
          <code [class.-empty]="!startParam">{{ startParamReady ? (startParam ?? '—') : '…' }}</code>
        </p>
      </header>
      @for (item of scenarios; track item.route) {
        <article class="card">
          <h2>{{ item.title }}</h2>
          <p class="scopes">Скоупы: <code>{{ item.scopes.join(', ') }}</code></p>
          <a class="btn" [routerLink]="item.route">Открыть</a>
        </article>
      }
    </div>
  `,
})
export class HomeComponent implements OnInit, OnDestroy {
  appName = 'Загрузка...';
  startParam: string | null = null;
  startParamReady = false;
  scenarios = [
    { title: 'Вход', scopes: [AWScope.USER_DATA], route: '/auth' },
    { title: 'Донат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay' },
    { title: 'Покупка и возврат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay-refund' },
    { title: 'Открыть апку', scopes: [AWScope.USER_DATA], route: '/open-app' },
  ];

  private sdk: AWSDK | null = null;
  private alive = true;

  ngOnInit() {
    void this.load();
  }

  ngOnDestroy() {
    this.alive = false;
    this.sdk?.destroy();
    this.sdk = null;
  }

  private async load() {
    try {
      const config = (await fetch('./config.json').then((r) => r.json())) as { id: string; name: string };
      if (!this.alive) return;
      this.appName = config.name;
      await this.readStartParam(config.id);
    } catch {
      if (this.alive) this.startParam = null;
    } finally {
      if (this.alive) this.startParamReady = true;
    }
  }

  private async readStartParam(appId: string) {
    if (cachedStartParam !== undefined) {
      this.startParam = cachedStartParam;
      return;
    }
    if (!AWSDK.isInsideWallet()) {
      cachedStartParam = null;
      return;
    }

    const instance = new AWSDK({
      appId,
      scopes: [],
      parentOrigin: getParentOrigin(),
      persistSession: false,
    });
    if (!this.alive) {
      instance.destroy();
      return;
    }
    this.sdk = instance;

    instance.events.on('sdk.ready', () => {
      if (!this.alive) return;
      this.startParam = instance.startParam;
    });
    instance.events.on('sdk.error', () => {
      if (!this.alive) return;
      this.startParam = null;
    });

    await instance.init();
    if (!this.alive) return;
    cachedStartParam = instance.startParam;
    this.startParam = cachedStartParam;
  }
}
