import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AWScope } from '@antarctic-wallet/aw-sdk';

const scenarios = [
  { title: 'Вход', scopes: [AWScope.USER_DATA], route: '/auth' },
  { title: 'Донат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay' },
  { title: 'Покупка и возврат', scopes: [AWScope.USER_DATA, AWScope.PAY], route: '/pay-refund' },
];

export function Home() {
  const [appName, setAppName] = useState('Загрузка...');

  useEffect(() => {
    void fetch('./config.json')
      .then((r) => r.json())
      .then((config: { name: string }) => setAppName(config.name));
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1 className="home-title">{appName}</h1>
      </header>
      {scenarios.map((item) => (
        <article key={item.route} className="card">
          <h2>{item.title}</h2>
          <p className="scopes">
            Скоупы: <code>{item.scopes.join(', ')}</code>
          </p>
          <Link className="btn" to={item.route}>
            Открыть
          </Link>
        </article>
      ))}
    </div>
  );
}
