/**
 * `POST /api/v1/stats` wall-clock p95 (task 5.11, 006-validation V10): 20
 * metrics × 3 variations at 100k draws, over real HTTP, p95 < 300 ms.
 *
 * Wall time on a shared, loaded box measures the scheduler, so this only runs
 * with `PRD006_PERF=1` (quiet machine: P6 / X0). The CPU-time budget of the
 * module itself is always checked in `stats.perf.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import app from '../../index.ts';

const ENABLED = process.env.PRD006_PERF === '1';
const P95_BUDGET_MS = 300;
const WARMUP = 3;
const SAMPLES = 20;

let server: Server | undefined;
let base = '';

beforeAll(() => {
  if (!ENABLED) return;
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server?.stop(true);
});

const body = JSON.stringify({
  control: 100,
  metrics: Array.from({ length: 20 }, (_, i) =>
    i % 2 === 0
      ? {
          key: `rate_${i}`,
          model: 'beta',
          variations: [100, 101, 102].map((variation, k) => ({
            variation,
            n: 4700 + 40 * k,
            x: 110 + 10 * k + i,
          })),
        }
      : {
          key: `mean_${i}`,
          model: 'normal',
          variations: [100, 101, 102].map((variation, k) => ({
            variation,
            n: 120 + k,
            sum: 9000 + 300 * k + i,
            sumSq: 900_000 + 30_000 * k,
          })),
        },
  ),
});

async function timedCall(): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${base}/api/v1/stats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Service-Token': config.serviceToken },
    body,
  });
  await res.text();
  if (res.status !== 200) throw new Error(`stats endpoint returned ${res.status}`);
  return performance.now() - start;
}

describe('stats endpoint performance (PRD006_PERF=1)', () => {
  it.skipIf(!ENABLED)(
    `20 metrics × 3 variations: p95 < ${P95_BUDGET_MS} ms`,
    async () => {
      for (let i = 0; i < WARMUP; i++) await timedCall();
      const times: number[] = [];
      for (let i = 0; i < SAMPLES; i++) times.push(await timedCall());
      const sorted = [...times].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Number.POSITIVE_INFINITY;
      process.stdout.write(
        `stats p95 ${p95.toFixed(1)} ms (median ${sorted[sorted.length >> 1]?.toFixed(1)} ms, n=${SAMPLES})\n`,
      );
      expect(p95).toBeLessThan(P95_BUDGET_MS);
    },
    60_000,
  );
});
