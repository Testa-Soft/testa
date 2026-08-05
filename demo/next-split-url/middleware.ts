import { createTestaMiddleware } from '@testa/next';

export const middleware = createTestaMiddleware({
  // A real client integration is just this line (host defaults to the package's
  // built-in prod host). Here we point `host` at the local collector.
  projectId: '12345',
  host: 'http://localhost:8090',
  trackingHost: 'http://localhost', // local crobot serves /api/leads
  cacheTtlMs: 1000,
  secureCookies: false, // local http dev
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
