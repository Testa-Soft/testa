/**
 * Shared constants + tiny env helper for `@testa-soft/next`.
 *
 * These live in their own module (rather than in `middleware.ts`) so the
 * server-component entry (`@testa-soft/next/server`) can reuse them WITHOUT
 * importing `middleware.ts` — which pulls in `next/server` (edge-only). The
 * middleware re-exports them so existing imports keep working unchanged.
 */

/**
 * Baked-in default config host. A client integration only needs `{ projectId }`;
 * the package already knows where to fetch config from. Override per-deployment
 * with the `host` option (or the `TESTA_CONFIG_HOST` env var).
 */
export const DEFAULT_CONFIG_HOST = 'https://config.testa-soft.tech';

/** Default host for exposure/conversion tracking (crobot's `/api/leads`). */
export const DEFAULT_TRACKING_HOST = 'https://new.testa-soft.tech';

/** Request header the middleware sets so the layout can gate `<TestaGuard/>`. */
export const SHIELD_HEADER = 'x-testa-shield';

/**
 * Read a process env var without ever throwing (e.g. edge runtimes where
 * `process` is undefined or partially polyfilled). Returns undefined when
 * unavailable so callers fall back to their own defaults.
 */
export function readEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}
