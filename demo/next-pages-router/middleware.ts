import { createTestaProxy } from '@testa-soft/next';
import { demoConfig } from './testa.config.ts';

// Identical to the App Router demo — the proxy is router-agnostic.
export const middleware = createTestaProxy({
  projectId: '12345',
  config: demoConfig, // inline → zero infra
  tracking: false, // no local /api/leads in the zero-infra demo
  secureCookies: false, // local http dev
  onVariationAssigned: (d) => {
    // eslint-disable-next-line no-console
    console.log(
      `[testa][server] variation_assigned exp=${d.experimentId} var=${d.variationId} first=${d.firstAssignment} url=${d.url}`,
    );
  },
});

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'],
};
