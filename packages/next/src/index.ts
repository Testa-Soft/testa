/**
 * @testa/next — Testa split-URL A/B testing for Next.js.
 *
 * v1: server-side, flicker-free split-URL redirects via middleware. No client
 * pixel, no analytics, no consent handling (see docs/prds/003-*).
 */

export {
  createTestaMiddleware,
  DEFAULT_CONFIG_HOST,
  DEFAULT_TRACKING_HOST,
} from './middleware.ts';
export type { TestaMiddleware, TestaMiddlewareOptions } from './middleware.ts';
export { emitExposure } from './tracking.ts';
export type { ExposurePayload } from './tracking.ts';
export { runExperiments } from '@testa-soft/experiment-core';
export type {
  EngineResult,
  EngineContext,
  VariationAppliedEvent,
} from '@testa-soft/experiment-core';
export { ConfigClient } from './config.ts';
export type { ConfigSource } from './config.ts';
export { NextCookieStore } from './cookie-store.ts';
export type { ReadableCookies, WritableCookies, NextCookieStoreOptions } from './cookie-store.ts';
export { ensureVisitorId } from './uuid.ts';
export { rootDomainOf, resolveCookieDomain } from './domain.ts';
export type { CookieDomainOptions } from './domain.ts';
