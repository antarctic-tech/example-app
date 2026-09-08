import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const scenarios = [
  { title: 'Вход', scopes: 'userData', route: '/auth' },
  { title: 'Донат', scopes: 'userData, pay', route: '/pay' },
  { title: 'Покупка и возврат', scopes: 'userData, pay, receive', route: '/pay-refund' },
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
            Скоупы: <code>{item.scopes}</code>
          </p>
          <Link className="btn" to={item.route}>
            Открыть
          </Link>
        </article>
      ))}
    </div>
  );
}
