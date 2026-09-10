import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AWScope } from '@antarctic-wallet/aw-sdk';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="app">
      <header class="header">
        <h1 class="home-title">{{ appName }}</h1>
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
export class HomeComponent implements OnInit {
  appName = 'Загрузка...';
  scenarios = [
    { title: 'Вход', scopes: [AWScope.USER_DATA], route: '/auth' },
    { title: 'Донат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay' },
    { title: 'Покупка и возврат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay-refund' },
  ];

  ngOnInit() {
    void fetch('./config.json')
      .then((r) => r.json())
      .then((config: { name: string }) => {
        this.appName = config.name;
      });
  }
}
