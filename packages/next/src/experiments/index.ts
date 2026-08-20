/**
 * `@testa-soft/next/experiments` — client-side DOM experiments (css/html/text/
 * attr/js/hide/insert/move) + anti-flicker guard. Separate entry so the
 * middleware bundle stays react-free (see tsup.config.ts). The middleware
 * assigns server-side; these render the assignment client-side.
 *
 * NOTE: these are the RAW client components (explicit `config` prop, guard is
 * NOT self-gating) for the inline-config / zero-infra path. Normal
 * integrations use `@testa-soft/next/server` instead.
 */

export { TestaProvider } from './TestaProvider.tsx';
export type { TestaProviderProps } from './TestaProvider.tsx';
export { TestaGuard } from './TestaGuard.tsx';
export type { TestaGuardProps } from './TestaGuard.tsx';
export {
  resolveAssignedExperiments,
  applyAssignedExperiments,
  revealShield,
} from './apply-assignments.ts';
export type { AssignedExperiment } from './apply-assignments.ts';
export { startGoalTracking } from './goal-tracking.ts';
export type { GoalCycleTeardown } from './goal-tracking.ts';
export { pushEvent } from '@testa-soft/dom';
export {
  isPreviewRequested,
  getPreviewToken,
  fetchPreviewChanges,
  normalizeChanges,
  PREVIEW_FLAG,
  PREVIEW_TOKEN,
  PREVIEW_VARIATION_ID,
} from './preview.ts';
