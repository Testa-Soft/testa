/**
 * @testa-soft/react — client-side Testa A/B testing for React + Vite SPAs
 * (single-page apps with no server).
 *
 * One `<TestaProvider/>` at the app root runs the full experiment cycle in the
 * browser: deterministic assignment (sticky `_testa_exp` cookie), client-side
 * split-URL redirects, cookie-first DOM changes, exposure tracking, preview
 * mode, and re-runs on SPA navigation. `useTestaVariant` is the robust
 * code-based path for experiments the app itself renders.
 */

export { TestaProvider } from './TestaProvider.tsx';
export type { TestaProviderProps } from './TestaProvider.tsx';
export { useTestaVariant } from './use-variant.ts';
export type { VariantResult } from './use-variant.ts';
export { TestaShield, raiseShield } from './shield.tsx';
export type { TestaShieldProps } from './shield.tsx';
export type { TestaContextValue } from './context.ts';

export { initTesta, ensureVisitorId } from './init.ts';
export type { InitOptions, InitResult } from './init.ts';
export { runExperiments } from '@testa-soft/experiment-core';
export type {
  EngineContext,
  EngineResult,
  VariationAppliedEvent,
} from '@testa-soft/experiment-core';
export { DocumentCookieStore } from './cookie-store.ts';
export type { DocumentCookieStoreOptions } from './cookie-store.ts';
export { ConfigClient, DEFAULT_CONFIG_HOST, preloadConfig, resolveConfigUrl } from './config.ts';
export type { ClientConfigSource, PreloadOptions } from './config.ts';
export {
  configNeedsShield,
  readShieldHint,
  writeShieldHint,
  SHIELD_HINT_KEY,
} from './shield-hint.ts';
export { emitExposure, DEFAULT_TRACKING_HOST } from './tracking.ts';
export type { ExposurePayload } from './tracking.ts';
export {
  applyAssignedExperiments,
  resolveAssignedExperiments,
  revealShield,
} from './apply-assignments.ts';
export type { AssignedExperiment } from './apply-assignments.ts';
export {
  isPreviewRequested,
  getPreviewToken,
  fetchPreviewChanges,
  normalizeChanges,
  PREVIEW_FLAG,
  PREVIEW_TOKEN,
  PREVIEW_VARIATION_ID,
} from './preview.ts';
export { installSpaNav, LOCATION_CHANGE_EVENT } from './spa-nav.ts';

// Client-side event bus (3.3.3 parity) — `testa.onVariationApplied(...)`,
// standalone fns, or `window.testa`. Same surface as `@testa-soft/next`.
export {
  testa,
  onVariationApplied,
  onVariationAssigned,
  emitVariationApplied,
  emitVariationAssigned,
  installTestaGlobal,
} from '@testa-soft/dom';
export type { VariationEvent, VariationHandler, Unsubscribe, TestaGlobal } from '@testa-soft/dom';
export { resolveExposures } from '@testa-soft/experiment-core';
export type { Exposure } from '@testa-soft/experiment-core';
