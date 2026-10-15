import { describe, expect, it } from 'bun:test';
import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import { SyncApiError } from '../errors.ts';
import { requireV2Experiment } from '../guards.ts';

function experiment(id: number, extra: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    experiment_id: id,
    status: 'active',
    rules: [],
    variations: [],
    goals: [],
    traffic_allocation: 100,
    ...extra,
  };
}

const project = {
  project_id: 42,
  experiments: [
    experiment(1717, { platform_version: 'v2' }),
    experiment(1, { platform_version: 'v1' }),
    experiment(2),
  ],
} as unknown as ProjectConfig;

function failure(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err instanceof SyncApiError ? { status: err.status, body: err.toBody() } : err;
  }
  return null;
}

describe('requireV2Experiment', () => {
  it('returns the v2 experiment', () => {
    expect(requireV2Experiment(project, 1717).experiment_id).toBe(1717);
  });

  it('404 experiment_not_found when absent or no config', () => {
    const notFound = { status: 404, body: { error: 'experiment_not_found' } };
    expect(failure(() => requireV2Experiment(project, 999))).toEqual(notFound);
    expect(failure(() => requireV2Experiment(null, 1717))).toEqual(notFound);
  });

  it('409 version_mismatch for v1 and for a missing platform_version', () => {
    const mismatch = { status: 409, body: { error: 'version_mismatch' } };
    expect(failure(() => requireV2Experiment(project, 1))).toEqual(mismatch);
    expect(failure(() => requireV2Experiment(project, 2))).toEqual(mismatch);
  });
});
