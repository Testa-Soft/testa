import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_COOKIE, parsePacked, runExperiments } from '../index.ts';
import { shuffleForVisitor } from '../order.ts';
import { memoryStore } from './memory-store.ts';

const PAGE = 'https://acme.com/calculator';

function experiments(ids: number[]): Array<{ experiment_id: number }> {
  return ids.map((experiment_id) => ({ experiment_id }));
}

describe('shuffleForVisitor', () => {
  it('is deterministic — same visitor always gets the same order', () => {
    const list = experiments([1, 2, 3, 4, 5]);
    const a = shuffleForVisitor(list, 'visitor-x');
    const b = shuffleForVisitor(list, 'visitor-x');
    expect(a.map((e) => e.experiment_id)).toEqual(b.map((e) => e.experiment_id));
  });

  it('does not mutate the input array', () => {
    const list = experiments([1, 2, 3]);
    const before = list.map((e) => e.experiment_id);
    shuffleForVisitor(list, 'visitor-x');
    expect(list.map((e) => e.experiment_id)).toEqual(before);
  });

  it('orders roughly 50/50 across visitors for two experiments', () => {
    const list = experiments([1, 2]);
    let firstIsOne = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const shuffled = shuffleForVisitor(list, `visitor-${i}`);
      if (shuffled[0]?.experiment_id === 1) firstIsOne++;
    }
    // Uniform coin across visitors: allow ±5 percentage points on n=2000.
    expect(firstIsOne / n).toBeGreaterThan(0.45);
    expect(firstIsOne / n).toBeLessThan(0.55);
  });
});

/** The randomizer setup: BOTH experiments at 100% traffic, mutual exclusions. */
function randomizerConfig(): ProjectConfig {
  const experiment = (id: number, excludesId: number) => ({
    experiment_id: id,
    title: `Exp ${id}`,
    status: 'active' as const,
    traffic_allocation: 100,
    rules: [{ match_type: 'contains' as const, url_pattern: '/calculator' }],
    goals: [],
    exclusions: [
      { dimension: 'experiment', operator: 'equals' as const, value: String(excludesId) },
    ],
    variations: [
      { variation_id: 0, weight: 50, changes: [] },
      { variation_id: 1, weight: 50, changes: [] },
    ],
  });
  return {
    project_id: 1,
    slug: '1',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: 'h',
    experiments: [experiment(1, 2), experiment(2, 1)],
  };
}

describe('experiment randomizer (engine integration)', () => {
  it('splits visitors ~50/50 between two mutually-exclusive 100%-traffic experiments', () => {
    let inOne = 0;
    let inTwo = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const store = memoryStore();
      runExperiments(
        {
          config: randomizerConfig(),
          currentUrl: PAGE,
          visitorId: `visitor-${i}`,
          now: 1_000_000_000_000,
          getCookie: (name) => store.get(name),
        },
        store,
      );
      const map = parsePacked(store.get(ASSIGNMENT_COOKIE));
      const one = map.get(1);
      const two = map.get(2);
      const assignedOne = one !== undefined && !one.excluded && one.variation >= 0;
      const assignedTwo = two !== undefined && !two.excluded && two.variation >= 0;
      // Exactly one of the two — never both, never neither.
      expect(assignedOne !== assignedTwo).toBe(true);
      if (assignedOne) inOne++;
      if (assignedTwo) inTwo++;
    }
    expect(inOne + inTwo).toBe(n);
    expect(inOne / n).toBeGreaterThan(0.45);
    expect(inOne / n).toBeLessThan(0.55);
  });

  it('keeps the same visitor in the same experiment across repeat pageviews', () => {
    const store = memoryStore();
    const run = () =>
      runExperiments(
        {
          config: randomizerConfig(),
          currentUrl: PAGE,
          visitorId: 'sticky-visitor',
          now: 1_000_000_000_000,
          getCookie: (name) => store.get(name),
        },
        store,
      );
    run();
    const first = store.get(ASSIGNMENT_COOKIE);
    run();
    run();
    expect(store.get(ASSIGNMENT_COOKIE)).toBe(first);
  });
});
