import { createRouter, createWebHashHistory } from 'vue-router';
import Home from './Home.vue';
import Auth from './scenarios/Auth.vue';
import Pay from './scenarios/Pay.vue';
import PayRefund from './scenarios/PayRefund.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/auth', name: 'auth', component: Auth },
    { path: '/pay', name: 'pay', component: Pay },
    { path: '/pay-refund', name: 'pay-refund', component: PayRefund },
  ],
});
