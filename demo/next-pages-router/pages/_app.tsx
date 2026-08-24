/**
 * The ONE line of Pages Router client integration: <TestaProvider/> from
 * `@testa-soft/next/pages`. It self-wires the client engine (DOM changes,
 * goals, shield) AND the soft-nav router guard — no other component needed.
 * Inline `config` keeps the demo zero-infra; a real app passes `projectId`.
 */

import { TestaProvider } from '@testa-soft/next/pages';
import type { AppProps } from 'next/app';
import { demoConfig } from '../testa.config.ts';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <TestaProvider config={demoConfig} tracking={false} secureCookies={false}>
      <Component {...pageProps} />
    </TestaProvider>
  );
}
