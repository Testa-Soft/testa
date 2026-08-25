import { TestaProvider, TestaGuard } from '@testa-soft/next/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PROD_PROJECT_ID, demoConfig, useProdConfig } from '../testa.config.ts';
import { ReloadSentinel } from './reload-sentinel.tsx';
import { TestaDebug } from './testa-debug.tsx';

export const metadata = {
  title: 'Testa split-URL + HTML demo',
  description: '@testa-soft/next split-URL redirects + client HTML/DOM experiments',
};

const navLink = { marginRight: 16, textDecoration: 'none' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Anti-flicker: hides the page pre-paint until the variant is applied,
            with a timeout fallback. Self-gating server component — only renders
            the shield script when the middleware signals a pending DOM change for
            this request (the `x-testa-shield` header), so split-URL-only pages
            never get shielded needlessly. */}
        <TestaGuard selector="body" timeoutMs={4000} />
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
          <Link href="/calculator" style={navLink}>
            Calculator
          </Link>
        </nav>
        {children}
        {/* Applies the visitor's assigned DOM experiments (cookie-first) + reveals the shield.
            `previewApiUrl` enables `?testa_preview=true&testa_preview_token=…` to fetch + apply
            draft changes from the backend (crobot). Here it points at the demo origin so the
            preview endpoint can be stubbed; in production it's the crobot app URL. */}
        {/* `tracking`/`secureCookies` mirror the proxy's own options: the client
            engine only runs when the proxy deferred (cold isolate / no config),
            and when it does it writes the cookie and emits the exposure itself —
            so it must be configured the same way, or the demo would report
            enrollments into the real project over http-rejected cookies. */}
        {useProdConfig ? (
          <TestaProvider projectId={PROD_PROJECT_ID} tracking={false} secureCookies={false} />
        ) : (
          <TestaProvider
            config={demoConfig}
            previewApiUrl="http://localhost:3200"
            tracking={false}
            secureCookies={false}
          />
        )}
        <TestaDebug />
        <ReloadSentinel />
      </body>
    </html>
  );
}
