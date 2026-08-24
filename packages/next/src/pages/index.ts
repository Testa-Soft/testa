/**
 * `@testa-soft/next/pages` — the Pages Router surface: one `<TestaProvider/>`
 * in `_app.tsx` (client engine + soft-nav router guard, self-wired). The App
 * Router twin lives at `@testa-soft/next/server`.
 */

export { TestaProvider } from './TestaProvider.tsx';
export type { TestaProviderProps } from './TestaProvider.tsx';
// Escape hatches for apps that want the pieces individually.
export { TestaRouterGuard } from '../router-guard/TestaRouterGuard.tsx';
export type { TestaRouterGuardProps } from '../router-guard/TestaRouterGuard.tsx';
