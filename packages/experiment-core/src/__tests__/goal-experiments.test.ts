import type { GoalConfig, ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { resolveGoalExperiments } from '../engine.ts';
import { serializePacked } from '../packed-cookie.ts';

const NOW_SEC = 1_000_000_000;
const LIVE = NOW_SEC + 600; // session window still open
const DEAD = NOW_SEC - 600; // session window expired

const QUIZ_GOAL: GoalConfig = {
  goal_id: 7,
  type: 'page_view',
  match_type: 'contains',
  action: '/quiz',
};

function cfg(goals: GoalConfig[], status: 'active' | 'paused' = 'active'): ProjectConfig {
  return {
    project_id: 1,
    slug: '1',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: 'h',
    experiments: [
      {
        experiment_id: 1,
        status,
        traffic_allocation: 100,
        // Goals are NOT page-gated: rules point at /calculator, but the goal
        // must be resolvable while the visitor browses /quiz.
        rules: [{ match_type: 'contains', url_pattern: '/calculator' }],
        goals,
        variations: [
          { variation_id: 0, weight: 0, changes: [] },
          { variation_id: 1, weight: 100, changes: [] },
        ],
      },
    ],
  };
}

function cookie(variation: number, sessionExp: number, excluded = false): string {
  return serializePacked(new Map([[1, { variation, excluded, sessionExp }]]));
}

describe('resolveGoalExperiments', () => {
  it('returns assigned experiments with their goals, ignoring page rules', () => {
    const out = resolveGoalExperiments(cfg([QUIZ_GOAL]), cookie(1, LIVE), NOW_SEC);
    expect(out).toEqual([{ experimentId: 1, variationId: 1, goals: [QUIZ_GOAL] }]);
  });

  it('includes control assignments (variation 0)', () => {
    const out = resolveGoalExperiments(cfg([QUIZ_GOAL]), cookie(0, LIVE), NOW_SEC);
    expect(out[0]?.variationId).toBe(0);
  });

  it('skips experiments without goals', () => {
    expect(resolveGoalExperiments(cfg([]), cookie(1, LIVE), NOW_SEC)).toEqual([]);
  });

  it('skips unassigned, excluded, and session-expired visitors (3.3.3 checkSession)', () => {
    const config = cfg([QUIZ_GOAL]);
    expect(resolveGoalExperiments(config, null, NOW_SEC)).toEqual([]);
    expect(resolveGoalExperiments(config, cookie(-1, LIVE, true), NOW_SEC)).toEqual([]);
    expect(resolveGoalExperiments(config, cookie(1, DEAD), NOW_SEC)).toEqual([]);
  });

  it('skips paused experiments', () => {
    expect(resolveGoalExperiments(cfg([QUIZ_GOAL], 'paused'), cookie(1, LIVE), NOW_SEC)).toEqual([]);
  });
});
