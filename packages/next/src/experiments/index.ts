/**
 * `@testa/next/experiments` — client-side DOM experiments (css/html/text/attr/
 * js/hide/insert/move) + anti-flicker shield. Separate entry so the middleware
 * bundle stays react-free (see tsup.config.ts). The middleware assigns
 * server-side; these render the assignment client-side.
 */

// Canonical names: <TestaProvider/> (DOM apply + goals) and <TestaGuard/>
// (anti-flicker). The originals stay exported as deprecated aliases.
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
export {
  resolveAssignedExperiments,
  applyAssignedExperiments,
  revealShield,
} from './apply-assignments.ts';
export { startGoalTracking } from './goal-tracking.ts';
export type { GoalCycleTeardown } from './goal-tracking.ts';
export { pushEvent } from '@testa-soft/dom';
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
