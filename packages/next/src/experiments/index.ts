/**
 * `@testa/next/experiments` — client-side DOM experiments (css/html/text/attr/
 * js/hide/insert/move) + anti-flicker shield. Separate entry so the middleware
 * bundle stays react-free (see tsup.config.ts). The middleware assigns
 * server-side; these render the assignment client-side.
 */

export { TestaExperiments } from './TestaExperiments.tsx';
export type { TestaExperimentsProps } from './TestaExperiments.tsx';
export { TestaShield } from './TestaShield.tsx';
export type { TestaShieldProps } from './TestaShield.tsx';
export {
  resolveAssignedExperiments,
  applyAssignedExperiments,
  revealShield,
} from './apply-assignments.ts';
export type { AssignedExperiment } from './apply-assignments.ts';
