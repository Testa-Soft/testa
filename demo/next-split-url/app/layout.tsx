import { TestaExperiments, TestaShield } from '@testa/next/experiments';
import type { ReactNode } from 'react';
import { demoConfig } from '../testa.config.ts';
import { ReloadSentinel } from './reload-sentinel.tsx';

export const metadata = {
  title: 'Testa split-URL + HTML demo',
  description: '@testa/next split-URL redirects + client HTML/DOM experiments',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Anti-flicker: hides the page pre-paint until the variant is applied,
            with a timeout fallback. Only needed for HTML/DOM experiments. */}
        <TestaShield selector="body" timeoutMs={4000} />
      </head>
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          maxWidth: 640,
          margin: '3rem auto',
          padding: '0 1rem',
        }}
      >
        {children}
        {/* Applies the visitor's assigned DOM experiments (cookie-first) + reveals the shield. */}
        <TestaExperiments config={demoConfig} />
        <ReloadSentinel />
      </body>
    </html>
  );
}
