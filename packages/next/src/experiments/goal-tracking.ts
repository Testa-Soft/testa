/**
 * Client-side goal tracking cycle — the glue between the shared goal controller
 * (`@testa-soft/dom`) and crobot's legacy `/api/leads/convert` endpoint.
 *
 * Called once per navigation from `<TestaExperiments/>`: arms page_view, click
 * and custom goals for every experiment the visitor is ASSIGNED to (session-
 * live, control included, NOT page-gated — a goal usually completes on a
 * different page than the experiment runs on). Custom goals fire via
 * `pushEvent('name', data)` (also installed as `window.testa.pushEvent` /
 * `window.Analytica.pushEvent` for docs parity).
 *
 * Conversions POST the 3.3.3 payload `{goal_id, action, lead_uuid, variation,
 * data}` so crobot results populate identically to the legacy pixel. crobot
 * dedups once-per-visitor server-side; the transport also guards once-per-load.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  createGoalController,
  emitLegacyConversion,
  installGoalGlobals,
  registerGoalController,
} from '@testa-soft/dom';
import { resolveGoalExperiments } from '@testa-soft/experiment-core';

export type GoalCycleTeardown = () => void;

/**
 * Arm goals for this navigation. Returns a teardown that removes click
 * listeners, pending retries, and the `pushEvent` registration — call it on
 * soft-nav / unmount before arming the next cycle.
 */
export function startGoalTracking(
  config: ProjectConfig,
  assignmentCookie: string | null,
  currentUrl: string,
  uuid: string,
  trackingHost: string,
  nowSec: number,
): GoalCycleTeardown {
  const assigned = resolveGoalExperiments(config, assignmentCookie, nowSec);
  if (assigned.length === 0) return () => {};

  installGoalGlobals();

  const controller = createGoalController({
    track: (_name, props = {}) => {
      const { goal_id, action, variation_id, goal_name, experiment_id, ...data } = props as {
        goal_id?: number;
        action?: string;
        variation_id?: number;
        goal_name?: string;
        experiment_id?: number;
        [k: string]: unknown;
      };
      if (typeof goal_id !== 'number' || typeof action !== 'string') return;
      void emitLegacyConversion(trackingHost, {
        goal_id,
        action,
        lead_uuid: uuid,
        variation: variation_id ?? 0,
        data,
      });
    },
  });

  controller.register(assigned, currentUrl);
  const unregister = registerGoalController(controller);

  return () => {
    unregister();
    controller.teardown();
  };
}
