import { createTestaProxy } from '@testa-soft/next';
import { PROD_PROJECT_ID, demoConfig, useProdConfig } from './testa.config.ts';

/**
 * `TESTA_DEMO_DECISIONS=client|server|hybrid` — where the decision is made.
 *
 * `client` is the one to reach for when testing the CLIENT fallback: the proxy
 * then never fetches a config and never decides, which is exactly the state a
 * cold serverless isolate is in under the default `hybrid`, except reproducible
 * on every request instead of only the first. The client engine must then do
 * everything itself — bucket, write `_testa_exp`, redirect, apply the HTML.
 */
const decisions = process.env.TESTA_DEMO_DECISIONS as 'hybrid' | 'server' | 'client' | undefined;

/**
 * `TESTA_DEMO_LEGACY=1` — adopt legacy 3.x pixel cookies, the cutover flag.
 *
 * To exercise it, give yourself a legacy assignment in the browser console and
 * reload `/pricing`:
 *
 *   document.cookie = '_testa_exp_101=2; path=/'   // variant → expect a 307
 *   document.cookie = '_testa_exp_101=1; path=/'   // control → expect no redirect
 *
 * Pair it with `TESTA_DEMO_DECISIONS=client` to prove the COLD path: the proxy
 * then has no config at all and still has to keep you on your legacy variation,
 * reading the experiment ids out of your own cookie jar.
 */
const legacyCookiesEnabled = process.env.TESTA_DEMO_LEGACY === '1';

export const middleware = createTestaProxy({
  ...(decisions ? { decisions } : {}),
  // Inline config → zero infra (no collector/crobot needed to run the demo).
  // A real integration passes only `{ projectId }` and fetches from the config
  // host; the middleware assigns split-URL AND DOM experiments the same way.
  // `TESTA_DEMO_PROD=1` switches to the REAL config API (see testa.config.ts).
  projectId: useProdConfig ? PROD_PROJECT_ID : '12345',
  ...(useProdConfig ? {} : { config: demoConfig }),
  ...(legacyCookiesEnabled ? { legacyCookiesEnabled: true } : {}),
  tracking: false, // no local /api/leads in the zero-infra demo
  secureCookies: false, // local http dev
  // SERVER-side event hook — logs to the dev-server console (your terminal),
  // not the browser. `ctx.waitUntil` would keep an async call (PostHog server,
  // webhook) alive past the response; here we just log.
  onVariationAssigned: (d, _ctx) => {
    // eslint-disable-next-line no-console
    console.log(
      `[testa][server] variation_assigned exp=${d.experimentId} var=${d.variationId} first=${d.firstAssignment} url=${d.url}`,
    );
  },
});

// OPTIONAL — the proxy already ignores /_next/*, /api/*, and static assets
// internally, so this matcher only saves the (no-op) edge invocation on them.
export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'],
};
