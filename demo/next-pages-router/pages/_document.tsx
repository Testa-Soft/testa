/**
 * The second half of the Pages Router integration: <TestaGuard/> in <Head>.
 *
 * Without it the browser paints the server-rendered control content before
 * React hydrates, so the provider's own shield (a layout effect) is always too
 * late and DOM experiments visibly flash. Only an inline <head> script runs
 * early enough. <TestaProvider/> in _app.tsx reveals it once the variant is on.
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
