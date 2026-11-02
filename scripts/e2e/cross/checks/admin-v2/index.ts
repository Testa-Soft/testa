/**
 * Layer `admin-v2` (crobot tasks/admin-v2/CONTRACT.md), in run order. Runs after
 * every other layer (it adds experiments + library goals to project 42);
 * sessions is last because logout-others ends the harness's other tokens.
 */

import type { CheckDef } from '../../lib/check.ts';
import { adminV2AnalyticsChecks } from './analytics.ts';
import { adminV2GoalChecks } from './goals.ts';
import { adminV2LibraryChecks } from './library.ts';
import { adminV2PageGoalChecks } from './page-goals.ts';
import { adminV2SessionChecks } from './sessions.ts';
import { adminV2TrackingChecks } from './tracking.ts';

export const adminV2Checks: readonly CheckDef[] = [
  ...adminV2GoalChecks,
  ...adminV2AnalyticsChecks,
  ...adminV2TrackingChecks,
  ...adminV2PageGoalChecks,
  ...adminV2LibraryChecks,
  ...adminV2SessionChecks,
];
