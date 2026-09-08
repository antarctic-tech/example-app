import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';
import { AuthComponent } from './scenarios/auth.component';
import { PayComponent } from './scenarios/pay.component';
import { PayRefundComponent } from './scenarios/pay-refund.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'auth', component: AuthComponent },
  { path: 'pay', component: PayComponent },
  { path: 'pay-refund', component: PayRefundComponent },
  { path: '**', redirectTo: '' },
];
