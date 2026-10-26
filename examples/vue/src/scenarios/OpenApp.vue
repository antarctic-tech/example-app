<script setup lang="ts">
/**
 * Сценарий: открыть другую мини-апку.
 *
 * sdk.openApp({ appId }).
 * Свой appId отклоняется в SDK и на хост не уходит.
 * Отказ хоста приходит как AWOpenAppError.errorCode.
 *
 * Скоуп userData нужен только для хендшейка. Самому openApp скоуп не нужен.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
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

const status = ref<Status>('idle');
const appName = ref('Загрузка...');
const currentAppId = ref('');
const openAppSupported = ref<boolean | null>(null);
const targetAppId = ref('');
const lastCall = ref('');
const message = ref('');
const messageTone = ref<MessageTone>('muted');
const loggingIn = ref(false);
const opening = ref(false);
const sdk = shallowRef<AWSDK | null>(null);
const router = useRouter();

const commandHint = computed(() => {
  if (openAppSupported.value === null) return 'Доступность open_app — после входа.';
  if (openAppSupported.value) return 'Хост заявил open_app.';
  return 'Хост не заявил open_app. Вызов вернёт unsupported.';
});

function note(text: string, tone: MessageTone) {
  message.value = text;
  messageTone.value = tone;
}

async function prepareSdk() {
  const config: AppConfig = await fetch('./config.json').then((r) => r.json());
  appName.value = config.name;
  currentAppId.value = config.id;

  const instance = new AWSDK({
    appId: config.id,
    scopes: [...SCOPES],
    parentOrigin: getParentOrigin(),
    persistSession: true,
  });
  sdk.value = instance;

  instance.backButton.onClick(() => {
    void router.push('/');
  });

  instance.events.on('sdk.ready', () => {
    status.value = 'ready';
    openAppSupported.value = instance.isCommandAvailable(AWCommand.OpenApp);
    note('', 'muted');
  });

  instance.events.on('sdk.error', ({ message: text }) => {
    status.value = 'error';
    openAppSupported.value = null;
    note(text, 'error');
  });

  instance.events.on('session.expired', () => {
    status.value = 'error';
    openAppSupported.value = null;
    note('Сессия истекла — войдите снова.', 'error');
  });

  void login();
}

async function login() {
  const instance = sdk.value;
  if (!instance || loggingIn.value) return;

  loggingIn.value = true;
  status.value = 'connecting';
  note('', 'muted');
  try {
    const pending = instance.init();
    try {
      instance.backButton.show();
    } catch (error) {
      note(asErrorMessage(error), 'error');
    }
    await pending;
  } catch (error) {
    status.value = 'error';
    if (error instanceof AWInitError || error instanceof AWTimeoutError) {
      note(asErrorMessage(error), 'error');
    } else {
      note(asErrorMessage(error), 'error');
    }
  } finally {
    loggingIn.value = false;
  }
}

async function openTarget() {
  const instance = sdk.value;
  if (!instance || opening.value || status.value !== 'ready') return;

  const params = { appId: targetAppId.value };
  lastCall.value = `sdk.openApp(${JSON.stringify(params, null, 2)})`;
  opening.value = true;
  note('', 'muted');
  try {
    await instance.openApp(params);
    note('Кошелёк принял вызов.', 'ok');
  } catch (error) {
    if (error instanceof AWOpenAppError) {
      note(`${error.errorCode} · ${error.message}`, 'error');
    } else if (error instanceof AWTimeoutError) {
      note(error.message, 'error');
    } else {
      note(asErrorMessage(error), 'error');
    }
  } finally {
    opening.value = false;
  }
}

onMounted(() => {
  void prepareSdk();
});

onUnmounted(() => {
  try {
    sdk.value?.backButton.hide();
  } catch {
    // хост мог уже закрыть канал
  }
  sdk.value?.destroy();
  sdk.value = null;
});
</script>

<template>
  <div class="app">
    <header class="header">
      <router-link class="back" to="/">← Все сценарии</router-link>
      <h1>{{ appName }} — Открыть апку</h1>
      <span :class="['dot', `-${status}`]"></span>
      <span class="muted">{{ STATUS_LABEL[status] }}</span>
    </header>

    <section v-if="status !== 'ready'" class="card">
      <p class="hint">
        Сначала войдите: хендшейк нужен, чтобы кошелёк принял
        <code>openApp</code>. Скоуп <code>userData</code> — только для входа.
      </p>
      <button
        class="btn"
        type="button"
        :disabled="!sdk || loggingIn || status === 'connecting'"
        @click="login"
      >
        {{ loggingIn || status === 'connecting' ? 'Подключение…' : 'Войти через Antarctic Wallet' }}
      </button>
    </section>

    <section class="card">
      <div class="label">Эта апка</div>
      <div class="value">{{ currentAppId || '—' }}</div>
      <p class="hint">{{ commandHint }}</p>

      <form @submit.prevent="openTarget">
        <label class="field">
          <span>appId</span>
          <input
            v-model="targetAppId"
            class="input"
            type="text"
            name="appId"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="id другой апки"
          />
        </label>

        <button class="btn" type="submit" :disabled="status !== 'ready' || opening">
          {{ opening ? 'Открытие…' : 'Открыть' }}
        </button>
      </form>

      <pre v-if="lastCall" class="call">{{ lastCall }}</pre>
      <p class="hint rules">
        Свой <code>appId</code> даёт <code>same_app</code>, и вызов на хост не уходит.
      </p>
    </section>

    <p v-if="message" :class="['status', `-${messageTone}`]">{{ message }}</p>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, system-ui, sans-serif;
  background: #0f1117;
  color: #e4e4e7;
}
.app { max-width: 420px; margin: 0 auto; padding: 20px; }
.header { margin-bottom: 16px; }
.back {
  display: inline-block;
  font-size: 12px;
  color: #818cf8;
  text-decoration: none;
  margin-bottom: 8px;
}
.header h1 { font-size: 18px; margin: 0 0 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; display: inline-block; }
.dot.-connecting { background: #f59e0b; }
.dot.-ready { background: #10b981; }
.dot.-error { background: #ef4444; }
.muted { color: #a1a1aa; font-size: 12px; }
.card {
  background: #1a1b26;
  border: 1px solid #2a2b3d;
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 12px;
}
.label { font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: #a1a1aa; margin-bottom: 6px; }
.value { font-weight: 600; word-break: break-all; }
.hint { font-size: 12px; color: #71717a; line-height: 1.5; margin: 8px 0 12px; }
.hint code { font-size: 11px; }
.rules { margin-bottom: 0; }
.field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.field span { font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: #a1a1aa; }
.input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #2a2b3d;
  background: #0f1117;
  color: #e4e4e7;
  font: inherit;
  font-size: 13px;
}
.input::placeholder { color: #52525b; }
.input:focus { outline: none; border-color: #6366f1; }
form .btn { margin-top: 12px; }
.call {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: #0f1117;
  border: 1px solid #2a2b3d;
  color: #c7d2fe;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}
.status { font-size: 13px; color: #a1a1aa; margin: 0; }
.status.-ok { color: #34d399; }
.status.-error { color: #fca5a5; }
.btn {
  width: 100%;
  padding: 10px 0;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #818cf8);
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
