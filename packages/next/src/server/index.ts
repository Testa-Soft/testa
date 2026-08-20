/**
 * `@testa-soft/next/server` — React Server Component surface.
 *
 * Drop `<TestaShield/>` in the `<head>` and `<TestaExperiments projectId=.../>`
 * in the `<body>` of the root layout; config is fetched server-side on the first
 * request and cached (Next data cache), so there is NO app-side fetch code.
 * `<TestaShield/>` is self-gating on the middleware's `x-testa-shield` header, so
 * it only renders where a DOM change is actually pending.
 */

export { TestaExperiments } from './TestaExperiments.tsx';
export type { TestaExperimentsProps } from './TestaExperiments.tsx';
export { TestaShield } from './TestaShield.tsx';
export type { TestaShieldProps } from './TestaShield.tsx';
export { loadTestaConfig } from './load-config.ts';
export type { LoadTestaConfigOptions } from './load-config.ts';
