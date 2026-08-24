/**
 * `@testa-soft/next/_internal/experiments` — INTERNAL. Do not import in app code;
 * use `@testa-soft/next/server` (`<TestaProvider projectId=.../>`) instead.
 *
 * This is the client half of the `/server` components: client-side DOM
 * experiments (css/html/text/attr/js/hide/insert/move) + anti-flicker guard.
 * It is a separate entry only because (a) the middleware bundle must stay
 * react-free and (b) the `/server` RSCs must import the `"use client"` bundle
 * via a package self-reference, which requires an exports-map path (see
 * tsup.config.ts). The `_internal` prefix marks it non-public: no semver
 * guarantees, no docs. Everything an app needs is on `.` (events/goals) and
 * `/server` (components — pass `config` inline there for the zero-infra path).
 *
 * These are the RAW client components: explicit `config` prop, guard is NOT
 * self-gating.
 *
 * @internal
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
