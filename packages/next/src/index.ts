/**
 * @testa/next — Testa split-URL A/B testing for Next.js.
 *
 * v1: server-side, flicker-free split-URL redirects via middleware. No client
 * pixel, no analytics, no consent handling (see docs/prds/003-*).
 */

export {
  createTestaProxy,
  DEFAULT_CONFIG_HOST,
  DEFAULT_TRACKING_HOST,
  SHIELD_HEADER,
} from './middleware.ts';
export { hasPendingDomChange, resolveExposures } from '@testa-soft/experiment-core';
export type { Exposure } from '@testa-soft/experiment-core';
export type { TestaProxy, TestaProxyOptions, VariationHookContext } from './middleware.ts';

// Client-side event bus (3.3.3 parity) — subscribe with `testa.onVariationApplied`,
// or the standalone fns; `window.testa` is installed by the client components.
export {
  testa,
  onVariationApplied,
  onVariationAssigned,
  emitVariationApplied,
  emitVariationAssigned,
  installTestaGlobal,
} from '@testa-soft/dom';
export type { VariationEvent, VariationHandler, Unsubscribe, TestaGlobal } from '@testa-soft/dom';
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
