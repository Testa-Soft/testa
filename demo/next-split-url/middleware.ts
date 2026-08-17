import { createTestaMiddleware } from '@testa-soft/next';
import { demoConfig } from './testa.config.ts';

export const middleware = createTestaMiddleware({
  // Inline config → zero infra (no collector/crobot needed to run the demo).
  // A real integration passes only `{ projectId }` and fetches from the config
  // host; the middleware assigns split-URL AND DOM experiments the same way.
  projectId: '12345',
  config: demoConfig,
  tracking: false, // no local /api/leads in the zero-infra demo
  secureCookies: false, // local http dev
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
