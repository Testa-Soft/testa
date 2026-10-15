/**
 * Stats module performance (task 5.10): 3 variations × 15 metrics × 100k draws
 * < 500 ms. Measured as this process's CPU time, not wall time: `pnpm -r test`
 * runs every package in parallel, and on a loaded machine wall time measures
 * the scheduler, not the module (281 ms wall alone vs 1,145 ms under G3).
 */
import { describe, expect, it } from 'bun:test';
import { type StatsRequest, computeStats } from '../index.ts';

const BUDGET_MS = 500;

function metric(i: number): StatsRequest {
  const beta = i % 2 === 0;
  return {
    model: beta ? 'beta' : 'normal',
    control: 100,
    draws: 100_000,
    seedKey: `|m${i}|`,
    variations: [100, 101, 102].map((variation, k) =>
      beta
        ? { variation, n: 4700 + k * 40, x: 110 + k * 10 + i }
        : { variation, n: 120 + k, sum: 9000 + 300 * k + i, sumSq: 900_000 + 30_000 * k },
    ),
  };
}

describe('stats performance', () => {
  it(`15 metrics × 3 variations × 100k draws in < ${BUDGET_MS} ms`, () => {
    const metrics = Array.from({ length: 15 }, (_, i) => metric(i));
    const start = process.cpuUsage();
    for (const m of metrics) computeStats(m);
    const used = process.cpuUsage(start);
    expect((used.user + used.system) / 1000).toBeLessThan(BUDGET_MS);
  });
});
