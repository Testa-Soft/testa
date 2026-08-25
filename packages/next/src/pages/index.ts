/**
 * `@testa-soft/next/pages` — the Pages Router surface: one `<TestaProvider/>`
 * in `_app.tsx` (client engine + soft-nav router guard + server-rendered
 * anti-flicker shield, all self-wired). The App Router twin lives at
 * `@testa-soft/next/server`.
 */

export { TestaProvider } from './TestaProvider.tsx';
export type { TestaProviderProps } from './TestaProvider.tsx';
// OPTIONAL `_document.tsx` addition: starts the config fetch during HTML parse
// (shortening the shielded window) plus a script shield. See TestaGuard.tsx.
export { TestaGuard } from './TestaGuard.tsx';
export type { TestaGuardProps } from './TestaGuard.tsx';
// The default shield, exported for apps that compose the pieces by hand.
export { HeadShield } from './HeadShield.tsx';
export type { HeadShieldProps } from './HeadShield.tsx';
// Escape hatches for apps that want the pieces individually.
export { TestaRouterGuard } from '../router-guard/TestaRouterGuard.tsx';
export type { TestaRouterGuardProps } from '../router-guard/TestaRouterGuard.tsx';
