import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Auth } from './scenarios/Auth';
import { Pay } from './scenarios/Pay';
import { PayRefund } from './scenarios/PayRefund';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/pay" element={<Pay />} />
        <Route path="/pay-refund" element={<PayRefund />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  </StrictMode>,
);
