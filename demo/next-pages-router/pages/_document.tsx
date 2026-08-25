/**
 * OPTIONAL half of the Pages Router integration: <TestaGuard/> in <Head>.
 *
 * Anti-flicker itself needs nothing here — <TestaProvider/> in _app.tsx
 * server-renders its own shield into <head>. What this adds is the CONFIG
 * FETCH, kicked off while the HTML is still parsing instead of after the bundle
 * has hydrated. The page stays hidden until the config lands, so this is the
 * difference between a hidden window measured in parse time and one measured in
 * bundle-download-plus-hydrate time.
 *
 * (This demo passes an inline config, so there's nothing to fetch — the guard
 * is here to exercise the composition: two shields, each released by its owner.)
 */

import { TestaGuard } from '@testa-soft/next/pages';
import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <TestaGuard />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
