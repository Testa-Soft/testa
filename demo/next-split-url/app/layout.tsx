import { TestaExperiments, TestaShield } from '@testa/next/experiments';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { demoConfig } from '../testa.config.ts';
import { ReloadSentinel } from './reload-sentinel.tsx';

export const metadata = {
  title: 'Testa split-URL + HTML demo',
  description: '@testa/next split-URL redirects + client HTML/DOM experiments',
};

const navLink = { marginRight: 16, textDecoration: 'none' };

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
        {/* Soft-nav links (client-side routing). The site-wide HTML experiment
            (202) re-applies its #hero badge on each navigation. */}
        <nav style={{ marginBottom: 24, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
          <Link href="/" style={navLink}>
            Home
          </Link>
          <Link href="/features" style={navLink}>
            Features
          </Link>
          <Link href="/about" style={navLink}>
            About
          </Link>
          <Link href="/pricing" style={navLink}>
            Pricing
          </Link>
        </nav>
        {children}
        {/* Applies the visitor's assigned DOM experiments (cookie-first) + reveals the shield.
            `previewApiUrl` enables `?testa_preview=true&testa_preview_token=…` to fetch + apply
            draft changes from the backend (crobot). Here it points at the demo origin so the
            preview endpoint can be stubbed; in production it's the crobot app URL. */}
        <TestaExperiments config={demoConfig} previewApiUrl="http://localhost:3100" />
        <ReloadSentinel />
      </body>
    </html>
  );
}
