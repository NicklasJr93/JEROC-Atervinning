import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './styles.css';
import { installPlatformFetchGuard } from './platform/session';
const OfficeApp = React.lazy(() => import('./office/OfficeApp').then(module => ({ default: module.OfficeApp })));
const PlatformGate = React.lazy(() => import('./platform/PlatformGate'));
const MobileApp = React.lazy(() => import('./MobileAppEntry'));
const TerminalApp = React.lazy(() => import('./terminal/TerminalApp'));
const DriverApp = React.lazy(() => import('./driver/DriverApp'));
const CustomerApp = React.lazy(() => import('./customer/CustomerApp'));
const CarrierApp = React.lazy(() => import('./carrier/CarrierApp'));
const pagePath = window.location.pathname.replace(/\/$/, '');
const nvvTestPage = pagePath === '/kontor/integration/systemadminintegrationtest.html';
const vismaTestPage = pagePath === '/kontor/integration/systemadminvismatest.html';
if (pagePath === '/kontor' || nvvTestPage || vismaTestPage) installPlatformFetchGuard();
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
        <React.Suspense fallback={<div role="status">Öppnar kontoret…</div>}><PlatformGate><OfficeApp /></PlatformGate></React.Suspense>
      ) : (
        <React.Suspense fallback={<div role="status">Öppnar appen…</div>}><MobileApp /></React.Suspense>
      )}
    </HashRouter>
  </React.StrictMode>,
);
