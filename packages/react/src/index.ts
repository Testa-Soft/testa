/**
 * @testa-soft/react — client-side Testa A/B testing for React + Vite SPAs
 * (Lovable and other apps with no server).
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
export { ConfigClient, DEFAULT_CONFIG_HOST, resolveConfigUrl } from './config.ts';
export type { ClientConfigSource } from './config.ts';
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
