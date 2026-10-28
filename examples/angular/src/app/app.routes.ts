import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';
import { AuthComponent } from './scenarios/auth.component';
import { PayComponent } from './scenarios/pay.component';
import { PayRefundComponent } from './scenarios/pay-refund.component';
import { ScopesComponent } from './scenarios/scopes.component';
import { OpenAppComponent } from './scenarios/open-app.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'auth', component: AuthComponent },
  { path: 'pay', component: PayComponent },
  { path: 'pay-refund', component: PayRefundComponent },
  { path: 'scopes', component: ScopesComponent },
  { path: 'open-app', component: OpenAppComponent },
  { path: '**', redirectTo: '' },
];
