/**
 * `@testa-soft/next/server` — React Server Component surface.
 *
 * Drop `<TestaGuard/>` in the `<head>` and `<TestaProvider projectId=.../>` in
 * the `<body>` of the root layout; config is fetched server-side on the first
 * request and cached (Next data cache), so there is NO app-side fetch code.
 * `<TestaGuard/>` is self-gating on the middleware's `x-testa-shield` header,
 * so it only renders where a DOM change is actually pending.
 */

export { TestaProvider } from './TestaProvider.tsx';
export type { TestaProviderProps } from './TestaProvider.tsx';
export { TestaGuard } from './TestaGuard.tsx';
export type { TestaGuardProps } from './TestaGuard.tsx';
export { loadTestaConfig } from './load-config.ts';
export type { LoadTestaConfigOptions } from './load-config.ts';
