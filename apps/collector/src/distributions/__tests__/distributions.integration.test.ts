/**
 * `view: distributions` live (task 5.16, 006-validation V13): reference
 * samples in real ClickHouse through the real sync HTTP route, asserted
 * against `docs/reference/samples/{f1,demo}/modeled/distributions.json`.
 *
 * Run: CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p7 \
 *      REDIS_URL=redis://localhost:6380 bun test src/distributions
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { DistributionsResult } from '@testa-platform/shared-types';
import { readGolden } from '../../modeler/__tests__/live.ts';
import { type QueryHarness, liveRedis, openHarness } from '../../products/__tests__/live-query.ts';

let h: QueryHarness;

const query = (projectId: number, from: string, to: string, extra: object = {}) => ({
  view: 'distributions',
  project_id: projectId,
  from,
  to,
  report_currency: 'EUR',
  ...extra,
});

function expectSharesSumToOne(r: DistributionsResult): void {
  for (const dist of Object.values(r.distributions)) {
    for (const buckets of Object.values(dist.by_variation)) {
      const list = buckets as { share: number | null }[];
      if (list.length === 0 || list.every((b) => b.share === null)) continue;
      expect(list.reduce((s, b) => s + (b.share ?? 0), 0)).toBeCloseTo(1, 5);
    }
  }
}

describe.skipIf(!liveRedis)('distributions view (live ClickHouse + Redis, real HTTP)', () => {
  beforeAll(async () => {
    h = await openHarness('distributions');
  });
  afterAll(async () => {
    await h.close();
  });

  it('F1 equals distributions.json', async () => {
    const { projectId, experimentId } = await h.setup('f1', [100, 101]);
    const r = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, '2026-10-01', '2026-10-03'),
    );
    expect(r).toEqual({
      ...readGolden<DistributionsResult>('f1', 'distributions.json'),
      experiment_id: experimentId,
    });
    expectSharesSumToOne(r);
  });

  it('demo equals distributions.json; shares sum to 1', async () => {
    const { projectId, experimentId } = await h.setup('demo', [100, 101, 102]);
    const r = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, '2026-10-01', '2026-10-14'),
    );
    expect(r).toEqual({
      ...readGolden<DistributionsResult>('demo', 'distributions.json'),
      experiment_id: experimentId,
    });
    expectSharesSumToOne(r);
  });

  it('subset, custom bins and cap_outliers', async () => {
    const { projectId, experimentId } = await h.setup('f1', [100, 101]);
    const range = ['2026-10-01', '2026-10-03'] as const;
    const only = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, ...range, { distributions: ['currency'] }),
    );
    expect(Object.keys(only.distributions)).toEqual(['currency']);

    const custom = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, ...range, { distributions: ['order_value'], order_value_bins: [0, 50, 90] }),
    );
    expect(custom.distributions.order_value?.bins).toEqual([0, 50, 90]);
    expect(custom.distributions.order_value?.by_variation['101']?.map((b) => b.count)).toEqual([
      1, 1, 0,
    ]);
    expect(custom.distributions.order_value?.by_variation['100']?.map((b) => b.count)).toEqual([
      0, 0, 1,
    ]);

    // F1 initial orders 100 / 45 / 80: p99 (exact, inclusive) caps 100 at 99.6.
    const capped = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, ...range, {
        distributions: ['order_value'],
        order_value_bins: [0, 99.7],
        cap_outliers: true,
      }),
    );
    expect(capped.distributions.order_value?.by_variation['100']?.map((b) => b.count)).toEqual([
      1, 0,
    ]);
    // R4: the capped-order count (hand-computed; generate.py `distributions(capped=True)` agrees).
    expect(capped.capped).toEqual({ threshold: 99.6, by_variation: { '100': 1, '101': 0 } });
    // Absent without cap_outliers.
    expect(custom.capped).toBeUndefined();
    expect(only.capped).toBeUndefined();
  });

  it('R4 capped: demo matches the oracle; reported even without order_value in the request', async () => {
    const { projectId, experimentId } = await h.setup('demo', [100, 101, 102]);
    const range = ['2026-10-01', '2026-10-14'] as const;
    const all = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, ...range, { cap_outliers: true }),
    );
    // generate.py distributions(M, capped=True) on the demo set.
    expect(all.capped).toEqual({ threshold: 298, by_variation: { '100': 1, '101': 1, '102': 1 } });
    const currencyOnly = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, ...range, { distributions: ['currency'], cap_outliers: true }),
    );
    expect(Object.keys(currencyOnly.distributions)).toEqual(['currency']);
    expect(currencyOnly.capped).toEqual(all.capped as NonNullable<typeof all.capped>);
    const off = await h.result<DistributionsResult>(
      experimentId,
      query(projectId, ...range, { cap_outliers: false }),
    );
    expect(off.capped).toBeUndefined();
  });

  it('400s through the route', async () => {
    const { projectId, experimentId } = await h.setup('f1', [100, 101]);
    const base = query(projectId, '2026-10-01', '2026-10-03');
    for (const [extra, field] of [
      [{ distributions: ['heatmap'] }, 'distributions'],
      [{ distributions: [] }, 'distributions'],
      [{ order_value_bins: [10, 5] }, 'order_value_bins'],
      [{ order_value_bins: [-1, 5] }, 'order_value_bins'],
      [{ cap_outliers: 'yes' }, 'cap_outliers'],
    ] as const) {
      expect(await h.call('POST', `/${experimentId}/queries`, { ...base, ...extra })).toEqual({
        status: 400,
        body: { error: 'unknown_metric', field },
      });
    }
  });
});
