/**
 * The ONE line of Pages Router client integration: <TestaProvider/> from
 * `@testa-soft/next/pages`. It self-wires the client engine (DOM changes,
 * goals), the soft-nav router guard, AND the server-rendered anti-flicker
 * shield — no other component, no `_document.tsx` edit needed.
 *
 * Two config sources, same provider:
 *   - default: the inline `config` — zero infra, resolves instantly.
 *   - `pnpm dev:slow`: `projectId` + a same-origin `host`, pointing at this
 *     demo's own /api/v1/config route, which stalls for NEXT_PUBLIC_TESTA_SLOW_MS.
 *     That's the one worth watching: the page is held blank for the whole delay
 *     and the FIRST thing painted is the variant. Never the control.
 */

import { TestaProvider } from '@testa-soft/next/pages';
import type { AppProps } from 'next/app';
import { DEMO_DELAY_MS, DEMO_PROJECT_ID, demoConfig } from '../testa.config.ts';

// The demo serves its own config route, so point `host` at this origin. (It has
// to be absolute — a falsy `host` falls back to the real config CDN.) The value
// differs between the server and browser renders, which is fine: `host` only
// picks the fetch URL, and only the browser fetches.
const demoHost =
  typeof window !== 'undefined'
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_TESTA_SLOW_HOST ?? 'http://localhost:3300');
const configSource =
  DEMO_DELAY_MS > 0 ? { projectId: DEMO_PROJECT_ID, host: demoHost } : { config: demoConfig };

export default function App({ Component, pageProps }: AppProps) {
  return (
    <TestaProvider {...configSource} tracking={false} secureCookies={false}>
      <Component {...pageProps} />
    </TestaProvider>
  );
}
