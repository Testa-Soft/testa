/**
 * `<TestaProvider/>` — `@testa-soft/next/pages`: the ONE component a Pages
 * Router app adds (in `_app.tsx`), twin of `@testa-soft/next/server`'s
 * provider for the App Router. Same name, one entry per router — a given app
 * file can only ever use one of them.
 *
 * It composes the client engine from `@testa-soft/react` (DOM changes, goals,
 * exposures) with `<HeadShield/>`, so nothing needs to be wired by hand.
 *
 * NO SPLIT-URL REDIRECT HAPPENS FROM HERE. Redirects on this router are the
 * proxy's job, on the document load, from the URL that arrived over the wire.
 * The client redirects at most once per page load — the initial cycle — and
 * never on a soft navigation.
 *
 * The reason is that a redirect is the only change that cannot be taken back. A
 * DOM change applied against a half-settled page re-applies correctly when the
 * page settles; a navigation commits once and takes the address bar with it. On
 * a soft nav the URL is not something the browser delivered, it is something the
 * application assembled — and an app that rebuilds its query from router state
 * hands over an incomplete one whenever the click beats hydration, which on a
 * slow in-app webview is often. Redirecting on that URL sends the visitor
 * somewhere they were never headed, carrying only the params the app had
 * managed to compute. `<TestaRouterGuard/>` used to do exactly this from
 * `routeChangeStart` — mid-navigation, on the least trustworthy value available
 * — and it is deliberately no longer mounted. It remains exported for anyone
 * who understands the trade and opts in explicitly.
 *
 * ANTI-FLICKER IS ON BY DEFAULT and needs no `_document.tsx`: `<HeadShield/>`
 * renders a JS-free `<style>` into `<head>` via `next/head` — server-rendered,
 * therefore in place before the browser's first paint — and unrenders it the
 * moment the variant is applied. A client-only shield can't do this: an effect
 * runs after the control content has painted, which turns one flash into two
 * (content → blank → variant). Pass `shield={false}` to own it yourself.
 *
 * ONE config fetch per page load, total, through the client provider's shared
 * `preloadConfig` cache — StrictMode's double-mount included. Nothing refetches
 * on soft navigation: the client engine re-runs its apply cycle against the
 * config it already holds.
 *
 * Mounted in the App Router by mistake, everything still behaves: the client
 * engine works anywhere React does. `/server` is the better surface there —
 * server-fetched config and the header-gated shield.
 */

import {
  TestaProvider as TestaClientProvider,
  type TestaProviderProps as TestaClientProviderProps,
} from '@testa-soft/react';
import type { JSX } from 'react';
import { HeadShield } from './HeadShield.tsx';

export type TestaProviderProps = TestaClientProviderProps;

export function TestaProvider(props: TestaProviderProps): JSX.Element {
  const { children, ...rest } = props;

  return (
    <TestaClientProvider {...rest}>
      {/* Rendered inside the client provider so it can read `settled` from its
          context — and so the shield goes down the moment the variant is on. */}
      <HeadShield
        {...(props.shield !== undefined ? { shield: props.shield } : {})}
        {...(props.config ? { config: props.config } : {})}
      />
      {children}
    </TestaClientProvider>
  );
}
