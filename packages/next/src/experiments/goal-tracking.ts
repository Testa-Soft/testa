/**
 * Client-side goal tracking cycle — the glue between the shared goal controller
 * (`@testa-soft/dom`) and crobot's legacy `/api/leads/convert` endpoint.
 *
 * Called once per navigation from `<TestaProvider/>`: arms page_view, click
 * and custom goals for every experiment the visitor is ASSIGNED to (session-
 * live, control included, NOT page-gated — a goal usually completes on a
 * different page than the experiment runs on). Custom goals fire via
 * `pushEvent('name', data)` (also installed as `window.testa.pushEvent` /
 * `window.Analytica.pushEvent` for docs parity).
 *
 * Conversions also go to the edge `/track` as `conversion` events (v2
 * experiments, goal_id lifted), and POST the 3.3.3 payload `{goal_id, action, lead_uuid, variation,
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
import { track } from '@testa-soft/react';

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
  // Install the pushEvent globals UNCONDITIONALLY: customer code calls
  // `window.testa.pushEvent(...)` / `window.Analytica.pushEvent(...)` without
  // knowing whether this visitor has goal-carrying assignments — the call must
  // always exist (it's a safe no-op when nothing is armed).
  installGoalGlobals();

  const assigned = resolveGoalExperiments(config, assignmentCookie, nowSec);
  if (assigned.length === 0) return () => {};

  const controller = createGoalController({
    track: (name, props = {}) => {
      // PRD-006: the same conversion to ClickHouse (v2 only; no-op otherwise).
      track(name, props);
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
