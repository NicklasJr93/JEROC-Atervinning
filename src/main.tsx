import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { OfficeApp } from './office/OfficeApp';
import { App } from './App';
import { DemoProvider } from './store';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      {window.location.pathname.replace(/\/$/, '') === '/kontor' ? (
        <OfficeApp />
      ) : (
        <DemoProvider>
          <App />
        </DemoProvider>
      )}
    </HashRouter>
  </React.StrictMode>,
);
