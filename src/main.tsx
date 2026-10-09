import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { OfficeApp } from './office/OfficeApp';
import { App } from './App';
import { DemoProvider } from './store';
import './styles.css';
const TerminalApp = React.lazy(() => import('./terminal/TerminalApp'));
const DriverApp = React.lazy(() => import('./driver/DriverApp'));
const pagePath = window.location.pathname.replace(/\/$/, '');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      {pagePath === '/terminal' ? (
        <React.Suspense fallback={<div role="status">Öppnar kundterminal…</div>}><TerminalApp /></React.Suspense>
      ) : pagePath === '/chauffor' ? (
        <React.Suspense fallback={<div role="status">Öppnar förarvyn…</div>}><DriverApp /></React.Suspense>
      ) : pagePath === '/kontor' ? (
        <OfficeApp />
      ) : (
        <DemoProvider>
          <App />
        </DemoProvider>
      )}
    </HashRouter>
  </React.StrictMode>,
);
