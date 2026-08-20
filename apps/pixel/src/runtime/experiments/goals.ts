/**
 * Goal detection — moved to `@testa-soft/dom` (`goals/controller.ts`) so the
 * React/Next SDKs share the exact same 3.3.3-parity controller. This module
 * re-exports it under the pixel's historical names; the pixel keeps wiring
 * `track` to the outbox → ClickHouse pipeline.
 */

export { createGoalController, urlMatchesGoal } from '@testa-soft/dom';
export type {
  GoalController,
  GoalDeps,
  GoalExperiment as AssignedExperiment,
  GoalTeardown as Teardown,
} from '@testa-soft/dom';
