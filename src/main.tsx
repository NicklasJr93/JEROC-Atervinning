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
const TestCarApp = React.lazy(() => import('./testcar/TestCarApp'));
const VoiceTestApp = React.lazy(() => import('./voice-test/VoiceTestApp'));
const PublicVoiceTestApp = React.lazy(() => import('./voice-test/PublicVoiceTestApp'));
const CustomerApprovalApp = React.lazy(() => import('./customer-approval/CustomerApprovalApp'));
const PublicCustomerIntakeApp = React.lazy(() => import('./customer-intake/PublicCustomerIntakeApp'));
const pagePath = window.location.pathname.replace(/\/$/, '');
const nvvTestPage = pagePath === '/kontor/integration/systemadminintegrationtest.html';
const vismaTestPage = pagePath === '/kontor/integration/systemadminvismatest.html';
const swishTestPage = pagePath === '/kontor/integration/systemadminswishtest.html';
const bankTestPage = pagePath === '/kontor/integration/systemadminbanktest.html';
const voiceTestPage = pagePath === '/rosttest';
const officeVoiceTestPage = pagePath === '/kontor/rosttest';
const standalonePortal = ['/godkann', '/kunduppgifter', '/testbil1', '/rosttest', '/terminal', '/chauffor', '/kund', '/akeri'].includes(pagePath);
// The mobile app keeps ordinary employee requests unchanged. When a real
// platform admin logs in, its in-memory session supplies same-origin API fences.
if (!standalonePortal) installPlatformFetchGuard();
if ((nvvTestPage || vismaTestPage || swishTestPage || bankTestPage) && !window.location.hash) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/integrations/${bankTestPage ? 'bank-test' : swishTestPage ? 'swish-test' : vismaTestPage ? 'visma-test' : 'nvv-test'}`);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      {pagePath === '/kunduppgifter' ? (
        <React.Suspense fallback={<div role="status">Öppnar kunduppgifterna…</div>}><PublicCustomerIntakeApp /></React.Suspense>
      ) : pagePath === '/godkann' ? (
        <React.Suspense fallback={<div role="status">Öppnar kundgodkännandet…</div>}><CustomerApprovalApp /></React.Suspense>
      ) : pagePath === '/testbil1' ? (
        <React.Suspense fallback={<div role="status">Öppnar testbilen…</div>}><TestCarApp /></React.Suspense>
      ) : voiceTestPage ? (
        <React.Suspense fallback={<div role="status">Öppnar rösttestet…</div>}><PublicVoiceTestApp /></React.Suspense>
      ) : officeVoiceTestPage ? (
        <React.Suspense fallback={<div role="status">Öppnar rösttestet…</div>}><PlatformGate><VoiceTestApp /></PlatformGate></React.Suspense>
      ) : pagePath === '/terminal' ? (
        <React.Suspense fallback={<div role="status">Öppnar kundterminal…</div>}><TerminalApp /></React.Suspense>
      ) : pagePath === '/chauffor' ? (
        <React.Suspense fallback={<div role="status">Öppnar förarvyn…</div>}><DriverApp /></React.Suspense>
      ) : pagePath === '/kund' ? (
        <React.Suspense fallback={<div role="status">Öppnar kundportalen…</div>}><CustomerApp /></React.Suspense>
      ) : pagePath === '/akeri' ? (
        <React.Suspense fallback={<div role="status">Öppnar åkeriportalen…</div>}><CarrierApp /></React.Suspense>
      ) : pagePath === '/kontor' || nvvTestPage || vismaTestPage || swishTestPage || bankTestPage ? (
        <React.Suspense fallback={<div role="status">Öppnar kontoret…</div>}><PlatformGate><OfficeApp /></PlatformGate></React.Suspense>
      ) : (
        <React.Suspense fallback={<div role="status">Öppnar appen…</div>}><MobileApp /></React.Suspense>
      )}
    </HashRouter>
  </React.StrictMode>,
);
