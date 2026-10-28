import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AWScope, AWSDK } from '@antarctic-wallet/aw-sdk';

const scenarios = [
  { title: 'Вход', scopes: [AWScope.USER_DATA], route: '/auth' },
  { title: 'Донат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay' },
  { title: 'Покупка и возврат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay-refund' },
  {
    title: 'Скоупы',
    scopes: [AWScope.USER_DATA, AWScope.BALANCE, AWScope.PAY],
    note: 'выбор перед входом',
    route: '/scopes',
  },
  { title: 'Открыть апку', scopes: [AWScope.USER_DATA], route: '/open-app' },
];

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

export function Home() {
  const [appName, setAppName] = useState('Загрузка...');
  const [startParam, setStartParam] = useState<string | null>(null);
  const [startParamReady, setStartParamReady] = useState(false);
  const sdk = useRef<AWSDK | null>(null);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const config = (await fetch('./config.json').then((r) => r.json())) as { id: string; name: string };
        if (!alive) return;
        setAppName(config.name);

        if (cachedStartParam !== undefined) {
          setStartParam(cachedStartParam);
          return;
        }
        if (!AWSDK.isInsideWallet()) {
          cachedStartParam = null;
          return;
        }

        const instance = new AWSDK({
          appId: config.id,
          scopes: [],
          parentOrigin: getParentOrigin(),
          persistSession: false,
        });
        if (!alive) {
          instance.destroy();
          return;
        }
        sdk.current = instance;

        instance.events.on('sdk.ready', () => {
          if (!alive) return;
          setStartParam(instance.startParam);
        });
        instance.events.on('sdk.error', () => {
          if (!alive) return;
          setStartParam(null);
        });

        await instance.init();
        if (!alive) return;
        cachedStartParam = instance.startParam;
        setStartParam(cachedStartParam);
      } catch {
        if (alive) setStartParam(null);
      } finally {
        if (alive) setStartParamReady(true);
      }
    })();

    return () => {
      alive = false;
      sdk.current?.destroy();
      sdk.current = null;
    };
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1 className="home-title">{appName}</h1>
        <p className="start-param">
          start_param:{' '}
          <code className={!startParam ? '-empty' : undefined}>
            {startParamReady ? (startParam ?? '—') : '…'}
          </code>
        </p>
      </header>
      {scenarios.map((item) => (
        <article key={item.route} className="card">
          <h2>{item.title}</h2>
          <p className="scopes">
            Скоупы: <code>{item.scopes.join(', ')}</code>
            {'note' in item && item.note ? `, ${item.note}` : ''}
          </p>
          <Link className="btn" to={item.route}>
            Открыть
          </Link>
        </article>
      ))}
    </div>
  );
}
