/**
 * `@testa-soft/next/server` — React Server Component surface.
 *
 * Drop `<TestaShield/>` in the `<head>` and `<TestaExperiments projectId=.../>`
 * in the `<body>` of the root layout; config is fetched server-side on the first
 * request and cached (Next data cache), so there is NO app-side fetch code.
 * `<TestaShield/>` is self-gating on the middleware's `x-testa-shield` header, so
 * it only renders where a DOM change is actually pending.
 */

// Canonical names: <TestaProvider/> (config fetch + DOM apply + goals) and
// <TestaGuard/> (anti-flicker). The originals stay exported as deprecated aliases.
export { TestaExperiments as TestaProvider } from './TestaExperiments.tsx';
export type { TestaExperimentsProps as TestaProviderProps } from './TestaExperiments.tsx';
export { TestaShield as TestaGuard } from './TestaShield.tsx';
export type { TestaShieldProps as TestaGuardProps } from './TestaShield.tsx';
/** @deprecated Renamed — use `TestaProvider`. */
export { TestaExperiments } from './TestaExperiments.tsx';
export type { TestaExperimentsProps } from './TestaExperiments.tsx';
/** @deprecated Renamed — use `TestaGuard`. */
export { TestaShield } from './TestaShield.tsx';
export type { TestaShieldProps } from './TestaShield.tsx';
export { loadTestaConfig } from './load-config.ts';
export type { LoadTestaConfigOptions } from './load-config.ts';
