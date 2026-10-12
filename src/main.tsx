import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { OfficeApp } from './office/OfficeApp';
import { App } from './App';
import { DemoProvider } from './store';
import { EmployeeProvider } from './employee/EmployeeProvider';
import './styles.css';
const TerminalApp = React.lazy(() => import('./terminal/TerminalApp'));
const DriverApp = React.lazy(() => import('./driver/DriverApp'));
const CustomerApp = React.lazy(() => import('./customer/CustomerApp'));
const CarrierApp = React.lazy(() => import('./carrier/CarrierApp'));
const pagePath = window.location.pathname.replace(/\/$/, '');
const nvvTestPage = pagePath === '/kontor/integration/systemadminintegrationtest.html';
const vismaTestPage = pagePath === '/kontor/integration/systemadminvismatest.html';
if ((nvvTestPage || vismaTestPage) && !window.location.hash) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/integrations/${vismaTestPage ? 'visma-test' : 'nvv-test'}`);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      {pagePath === '/terminal' ? (
        <React.Suspense fallback={<div role="status">Öppnar kundterminal…</div>}><TerminalApp /></React.Suspense>
      ) : pagePath === '/chauffor' ? (
        <React.Suspense fallback={<div role="status">Öppnar förarvyn…</div>}><DriverApp /></React.Suspense>
      ) : pagePath === '/kund' ? (
        <React.Suspense fallback={<div role="status">Öppnar kundportalen…</div>}><CustomerApp /></React.Suspense>
      ) : pagePath === '/akeri' ? (
        <React.Suspense fallback={<div role="status">Öppnar åkeriportalen…</div>}><CarrierApp /></React.Suspense>
      ) : pagePath === '/kontor' || nvvTestPage || vismaTestPage ? (
        <OfficeApp />
      ) : (
        <EmployeeProvider>
          <DemoProvider>
            <App />
          </DemoProvider>
        </EmployeeProvider>
      )}
    </HashRouter>
  </React.StrictMode>,
);
