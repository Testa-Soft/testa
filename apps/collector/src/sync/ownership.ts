/**
 * R3 ownership: experiment ids repeat across projects, so a request names its
 * project and the experiment must be in that project's config. A project that
 * doesn't own the experiment gets 404 `experiment_not_found`.
 */
import type { ExperimentConfig } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { requireV2Experiment } from '../analytics/guards.ts';
import { configForProject } from '../modeler/project-config.ts';
import type { SyncContext } from './context.ts';

/** The project's v2 experiment, or 404 `experiment_not_found` / 409 `version_mismatch`. */
export async function requireOwnedV2(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
): Promise<ExperimentConfig> {
  return requireV2Experiment(await configForProject(ctx.configStore, projectId), experimentId);
}

/** Throws 404 `experiment_not_found` unless the project's config lists the experiment. */
export async function requireOwned(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
): Promise<void> {
  const config = await configForProject(ctx.configStore, projectId);
  if (!config?.experiments.some((e) => e.experiment_id === experimentId)) {
    throw new SyncApiError('experiment_not_found', 404);
  }
}
