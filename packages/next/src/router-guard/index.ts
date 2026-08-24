/**
 * `@testa/next/router-guard` — the optional client-side soft-nav catch-all (M2).
 * Separate entry so the middleware bundle stays react-free (see tsup.config.ts).
 */

export { TestaRouterGuard } from './TestaRouterGuard.tsx';
export type { TestaRouterGuardProps } from './TestaRouterGuard.tsx';
export { resolveGuardConfig, clearGuardConfigCache } from './guard-config.ts';
export type { GuardConfigSource } from './guard-config.ts';
export {
  resolveGuardRedirect,
  installRouterGuard,
  ROUTE_ABORT,
} from './use-cookie-assignment.ts';
export type { GuardResolveInput, GuardRouter, GuardDeps } from './use-cookie-assignment.ts';
