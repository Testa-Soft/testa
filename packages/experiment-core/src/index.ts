/**
 * @testa-soft/experiment-core — host-agnostic experiment decision core.
 *
 * Consumed by `@testa-soft/next` (server) and (as a follow-up) the pixel (browser),
 * both supplying their own `CookieStore`. Keep this module free of any host
 * globals (`window`, `document`, `NextRequest`, …).
 */

export type { CookieStore, CookieSetOptions } from './cookie-store.ts';
export {
  UUID_COOKIE,
  ASSIGNMENT_COOKIE,
  REDIRECTED_COOKIE,
  ASSIGNMENT_TTL_SEC,
  REDIRECTED_TTL_SEC,
  UUID_TTL_SEC,
  redirectedName,
} from './cookie-store.ts';

export { passesTargeting, isExcludedByRules } from './targeting.ts';
export type { TargetingContext } from './targeting.ts';
export { decodeCrossDomain, encodeCrossDomainData, CROSS_DOMAIN_PARAM } from './cross-domain.ts';
export type { CrossDomainPayload, CrossDomainAssignment } from './cross-domain.ts';

export { SEED, xxhash32 } from './xxhash.ts';
export { assign, bucketOf, pickByWeight, applyAssignment, hasCachedAssignment } from './assign.ts';
export type {
  Experiment,
  Variation,
  AssignResult,
  AssignContext,
  ExcludedReason,
} from './assign.ts';

export {
  EXCLUDED_VARIATION_ID,
  parsePacked,
  serializePacked,
} from './packed-cookie.ts';
export type { ExpState, PackedExpMap } from './packed-cookie.ts';

export { decideRedirect, resolveRedirectDestination } from './redirect/decide.ts';
export type {
  RedirectDecision,
  RedirectInputs,
  RedirectReason,
  RedirectChange,
} from './redirect/decide.ts';
export { hasRedirected, markRedirected, clearRedirected } from './redirect/dedup.ts';
export { buildRedirectUrl, resolveMode } from './redirect/build-url.ts';
export type { RewriteMode } from './redirect/build-url.ts';
export { canonicalize, matchesUrl, matchesForMode } from './redirect/match.ts';
export { mergeParams } from './redirect/merge-params.ts';

// Experiment orchestration engine (page-gate → targeting/exclusions → assign →
// redirect resolution). Host-neutral; the @testa-soft/next + /react adapters
// import this instead of each carrying a copy.
export {
  runExperiments,
  hasPendingDomChange,
  matchesPageRule,
  resolveExposures,
  resolveGoalExperiments,
} from './engine.ts';
export type { Exposure, GoalAssignment } from './engine.ts';
export {
  SESSION_LENGTH_SEC,
  isSessionLive,
  isAssigned,
  isFresh,
} from './session.ts';
export type {
  EngineContext,
  EngineResult,
  VariationAppliedEvent,
  DecisionTrace,
  DecisionReason,
} from './engine.ts';
