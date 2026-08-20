/**
 * Cross-experiment (mutual) exclusion — crobot emits it as an `exclusions[]`
 * condition with `dimension: "experiment"`:
 *
 *   { dimension: 'experiment', operator: 'equals', value: '<experiment_id>' }
 *
 * Semantics: the visitor is excluded from THIS experiment while they are
 * ASSIGNED (variation ≥ 0, control included) to experiment `<value>`. Parked
 * eligibility (-2) and cached exclusions do NOT count as assignment. The lookup
 * parses the packed cookie FRESH via `getCookie`, so an assignment made earlier
 * in the SAME request (read-through store) is visible — the per-visitor
 * shuffled order (order.ts) is the priority order.
 *
 * The classic even-split setup this enables: A excludes B, B excludes A, A at
 * 50% traffic → every visitor lands in exactly one of the two (A's in-slice
 * half in A, the rest fall through to B).
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_COOKIE, parsePacked, runExperiments } from '../index.ts';
import { shuffleForVisitor } from '../order.ts';
import { memoryStore } from './memory-store.ts';

/**
 * Evaluation order is the per-visitor shuffle (see order.ts), not config
 * order. For order-sensitive assertions, pick a visitor whose shuffle puts
 * experiment 1 first — deterministic, so the test never flakes.
 */
function visitorWithExpFirst(firstId: number): string {
  const ids = [{ experiment_id: 1 }, { experiment_id: 2 }];
  for (let i = 0; i < 100; i++) {
    const visitor = `order-probe-${i}`;
    if (shuffleForVisitor(ids, visitor)[0]?.experiment_id === firstId) return visitor;
  }
  throw new Error('no probe visitor found — hash badly skewed?');
}

const PAGE = 'https://acme.com/calculator';

/** Two active experiments on the same page, mutually excluding each other. */
function mutexConfig(trafficA = 100): ProjectConfig {
  const experiment = (id: number, traffic: number, excludesId: number) => ({
    experiment_id: id,
    title: `Exp ${id}`,
    status: 'active' as const,
    traffic_allocation: traffic,
    rules: [{ match_type: 'contains' as const, url_pattern: '/calculator' }],
    goals: [],
    variations: [{ variation_id: 1, weight: 100, changes: [] }],
    exclusions: [{ dimension: 'experiment', operator: 'equals' as const, value: String(excludesId) }],
  });
  return {
    project_id: 1,
    slug: 'acme',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '2026-08-04T00:00:00.000Z',
    config_hash: 'mutex-1',
    experiments: [experiment(1, trafficA, 2), experiment(2, 100, 1)],
  };
}

type Store = ReturnType<typeof memoryStore>;

function run(store: Store, config: ProjectConfig, visitorId = 'v') {
  return runExperiments(
    { config, currentUrl: PAGE, visitorId, now: 1_000_000, getCookie: (n) => store.get(n) },
    store,
  );
}

function assignedIds(store: Store): number[] {
  const out: number[] = [];
  for (const [id, state] of parsePacked(store.get(ASSIGNMENT_COOKIE))) {
    if (!state.excluded && state.variation >= 0) out.push(id);
  }
  return out.sort();
}

describe('cross-experiment exclusion (dimension: experiment)', () => {
  it('same request: first-evaluated experiment assigns, second is excluded by it', () => {
    const store = memoryStore();
    const res = run(store, mutexConfig(100), visitorWithExpFirst(1));
    expect(assignedIds(store)).toEqual([1]);
    expect(res.applied.map((a) => a.experimentId)).toEqual([1]);
  });

  it('a visitor already assigned to exp 2 is excluded from exp 1', () => {
    // 2.1.0.0 = assigned to exp 2, variation 1
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '2.1.0.0' });
    run(store, mutexConfig(100));
    expect(assignedIds(store)).toEqual([2]);
  });

  it('parked eligibility (-2) does NOT count as assignment', () => {
    // 2.-2.0.9999999 = exp 2 eligible-parked, not assigned. With exp 1
    // evaluating first, a parked exp 2 must NOT exclude it → exp 1 enrolls.
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '2.-2.0.9999999' });
    run(store, mutexConfig(100), visitorWithExpFirst(1));
    expect(assignedIds(store)).toContain(1);
  });

  it('a visitor already in BOTH keeps both assignments but gets NEITHER applied (3.3.3 parity)', () => {
    // 3.3.3 `handleExclusions` runs BEFORE the sticky cookie is honoured, on
    // every pageview: each experiment sees the other's assignment and skips its
    // apply. The assignments themselves are never re-rolled or dropped.
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '1.1.0.0~2.1.0.0' });
    const res = run(store, mutexConfig(100));
    expect(assignedIds(store)).toEqual([1, 2]);
    expect(res.applied).toHaveLength(0);
  });

  it('A@50% + mutual exclusion = even split, every visitor in EXACTLY one', () => {
    let inA = 0;
    let inB = 0;
    for (let i = 0; i < 40; i++) {
      const store = memoryStore();
      run(store, mutexConfig(50), `visitor-${i}`);
      const ids = assignedIds(store);
      expect(ids.length).toBe(1); // never both, never neither
      if (ids[0] === 1) inA++;
      else inB++;
    }
    // Deterministic hash over 40 uuids — both sides must be populated.
    expect(inA).toBeGreaterThan(5);
    expect(inB).toBeGreaterThan(5);
  });

  it('the split is sticky across repeat requests', () => {
    const store = memoryStore();
    run(store, mutexConfig(50), 'sticky-visitor');
    const first = assignedIds(store);
    run(store, mutexConfig(50), 'sticky-visitor');
    run(store, mutexConfig(50), 'sticky-visitor');
    expect(assignedIds(store)).toEqual(first);
    expect(first.length).toBe(1);
  });
});
