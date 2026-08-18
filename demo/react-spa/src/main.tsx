import { TestaProvider } from '@testa-soft/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { demoConfig } from '../testa.config.ts';
import { App } from './App.tsx';

// <TestaProvider> runs the whole client experiment cycle: client-side assignment
// (sticky _testa_exp cookie), DOM apply via @testa-soft/dom, exposure tracking,
// preview mode, and re-apply on SPA navigation. `secureCookies={false}` for local http.
// StrictMode double-invokes effects in dev — a good check the apply is idempotent.
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <TestaProvider config={demoConfig} secureCookies={false}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </TestaProvider>
  </StrictMode>,
);
