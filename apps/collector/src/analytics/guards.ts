import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import { SyncApiError } from './errors.ts';

/**
 * PRD-006 analytics only serve v2 experiments (§6.1): 404 `experiment_not_found`
 * when the experiment isn't in the project's config, 409 `version_mismatch`
 * when it isn't `platform_version: 'v2'` (absent = v1).
 */
export function requireV2Experiment(
  config: ProjectConfig | null,
  experimentId: number,
): ExperimentConfig {
  const experiment = config?.experiments.find((e) => e.experiment_id === experimentId);
  if (!experiment) throw new SyncApiError('experiment_not_found', 404);
  if (experiment.platform_version !== 'v2') throw new SyncApiError('version_mismatch', 409);
  return experiment;
}
