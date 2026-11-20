/**
 * Pixel glue for the legacy crobot tracking calls (`network/legacy-leads.ts`):
 * resolves the tracking host + visitor id and gates on consent. One tracker per
 * page load (its per-load dedup lives with it).
 *
 * Host: `cfPrefill.trackingHost` (stamped by the serving worker), else the
 * SDKs' default crobot host.
 */

import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import * as consentMod from '../consent.ts';
import * as cookies from '../cookies.ts';
import {
  DEFAULT_TRACKING_HOST,
  type LegacyTracker,
  createLegacyTracker,
} from '../network/legacy-leads.ts';

let _tracker: LegacyTracker | null = null;
let _unsubscribe: (() => void) | null = null;

function tracker(): LegacyTracker {
  if (_tracker) return _tracker;
  const host =
    (typeof window !== 'undefined' ? window.cfPrefill?.trackingHost : undefined) ||
    DEFAULT_TRACKING_HOST;
  const created = createLegacyTracker({ host, isHeld: () => consentMod.consent.isHeld() });
  _tracker = created;
  _unsubscribe = consentMod.consent.subscribe((state) => created.onConsent(state));
  return created;
}

/** `POST /api/leads` for an experiment the visitor was just exposed to. */
export function legacyExposure(
  project: ProjectConfig,
  experiment: ExperimentConfig,
  variationId: number,
  url: string,
): void {
  const uuid = cookies.getUuid();
  if (!uuid) return;
  tracker().exposure({
    project_id: project.project_id,
    experiment: experiment.experiment_id,
    variation: variationId,
    uuid,
    ...(experiment.title !== undefined ? { title: experiment.title } : {}),
    url,
  });
}

/**
 * `POST /api/leads/convert` for a goal-controller `conversion`. Props are the
 * controller's `{goal_id, action, goal_name?, experiment_id, variation_id,
 * ...data}`; anything else is the custom event's data.
 */
export function legacyConversion(props: Record<string, unknown>): void {
  const { goal_id, action, variation_id, goal_name, experiment_id, ...data } = props;
  void goal_name;
  void experiment_id;
  if (typeof goal_id !== 'number' || typeof action !== 'string') return;
  const uuid = cookies.getUuid();
  if (!uuid) return;
  tracker().conversion({
    goal_id,
    action,
    lead_uuid: uuid,
    variation: typeof variation_id === 'number' ? variation_id : 0,
    data,
  });
}

/** Test hook. */
export function __resetLegacyTrackingForTests(): void {
  _unsubscribe?.();
  _unsubscribe = null;
  _tracker = null;
}
