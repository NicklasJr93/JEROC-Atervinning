import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { DemoProvider } from './store';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <DemoProvider>
        <App />
      </DemoProvider>
    </HashRouter>
  </React.StrictMode>,
);
