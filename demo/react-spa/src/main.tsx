import { TestaProvider } from '@testa-soft/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { PROD_CONFIG_HOST, PROD_PROJECT_ID, demoConfig, useProdConfig } from '../testa.config.ts';
import { App } from './App.tsx';

// <TestaProvider> runs the whole client experiment cycle: client-side assignment
// (sticky _testa_exp cookie), DOM apply via @testa-soft/dom, exposure tracking,
// preview mode, and re-apply on SPA navigation. `secureCookies={false}` for local http.
// StrictMode double-invokes effects in dev — a good check the apply is idempotent.
// `VITE_TESTA_DEMO_PROD=1` fetches the REAL config instead (see testa.config.ts);
// tracking stays off so demo enrollments never pollute the project's results.
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <TestaProvider
      {...(useProdConfig
        ? { projectId: PROD_PROJECT_ID, host: PROD_CONFIG_HOST }
        : { config: demoConfig })}
      // `VITE_TESTA_PREVIEW_API=http://localhost` resolves ?testa_preview tokens
      // minted by a local crobot (e.g. the testa MCP's preview tool).
      {...(import.meta.env.VITE_TESTA_PREVIEW_API
        ? { previewApiUrl: import.meta.env.VITE_TESTA_PREVIEW_API }
        : {})}
      tracking={false}
      secureCookies={false}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </TestaProvider>
  </StrictMode>,
);
