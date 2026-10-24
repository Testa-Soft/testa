/**
 * `view: products` live (task 5.16, 006-validation V13): reference samples in
 * real ClickHouse through the real sync HTTP route, asserted against
 * `docs/reference/samples/{f1,demo}/modeled/products*.json` (by_variation
 * keyed by variation id, exactly as the goldens).
 *
 * Run: CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p7 \
 *      REDIS_URL=redis://localhost:6380 bun test src/products
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ProductDetailResult, ProductsListResult } from '@testa-platform/shared-types';
import { readGolden } from '../../modeler/__tests__/live.ts';
import { type QueryHarness, liveRedis, openHarness } from './live-query.ts';

let h: QueryHarness;

const query = (projectId: number, from: string, to: string, extra: object = {}) => ({
  view: 'products',
  project_id: projectId,
  from,
  to,
  report_currency: 'EUR',
  ...extra,
});

/** Shares of one field over the listed products (incl. "Other") per variation. */
function shareSums(r: ProductsListResult, field: 'units_share' | 'revenue_share') {
  const sums: Record<string, number> = {};
  for (const p of r.products) {
    for (const [v, values] of Object.entries(p.by_variation)) {
      sums[v] = (sums[v] ?? 0) + (values[field] ?? 0);
    }
  }
  return sums;
}

describe.skipIf(!liveRedis)('products view (live ClickHouse + Redis, real HTTP)', () => {
  beforeAll(async () => {
    h = await openHarness('products');
  });
  afterAll(async () => {
    await h.close();
  });

  it('F1 equals products.json', async () => {
    const { projectId, experimentId } = await h.setup('f1', [100, 101]);
    const result = await h.result<ProductsListResult>(
      experimentId,
      query(projectId, '2026-10-01', '2026-10-03'),
    );
    const golden = readGolden<ProductsListResult>('f1', 'products.json');
    expect(result).toEqual({ ...golden, experiment_id: experimentId });
  });

  it('demo equals products.json and products.upsell.json; shares sum to 1', async () => {
    const { projectId, experimentId } = await h.setup('demo', [100, 101, 102]);
    const all = await h.result<ProductsListResult>(
      experimentId,
      query(projectId, '2026-10-01', '2026-10-14'),
    );
    expect(all).toEqual({
      ...readGolden<ProductsListResult>('demo', 'products.json'),
      experiment_id: experimentId,
    });
    for (const field of ['units_share', 'revenue_share'] as const) {
      for (const sum of Object.values(shareSums(all, field))) expect(sum).toBeCloseTo(1, 5);
    }

    const upsell = await h.result<ProductsListResult>(
      experimentId,
      query(projectId, '2026-10-01', '2026-10-14', { purchase_type: 'upsell' }),
    );
    expect(upsell).toEqual({
      ...readGolden<ProductsListResult>('demo', 'products.upsell.json'),
      experiment_id: experimentId,
    });
  });

  it('F1: purchase_type upsell → only SKU-U sold (variant, 1 unit)', async () => {
    const { projectId, experimentId } = await h.setup('f1', [100, 101]);
    const r = await h.result<ProductsListResult>(
      experimentId,
      query(projectId, '2026-10-01', '2026-10-03', { purchase_type: 'upsell' }),
    );
    const sold = r.products.filter((p) =>
      Object.values(p.by_variation).some((v) => v.units_purchased > 0),
    );
    expect(sold.map((p) => [p.product_id, p.by_variation['101']?.units_purchased])).toEqual([
      ['SKU-U', 1],
    ]);
  });

  it('paging, search and detail mode', async () => {
    const { projectId, experimentId } = await h.setup('demo', [100, 101, 102]);
    const range = ['2026-10-01', '2026-10-14'] as const;
    const page2 = await h.result<ProductsListResult>(
      experimentId,
      query(projectId, ...range, { limit: 3, offset: 3 }),
    );
    const full = readGolden<ProductsListResult>('demo', 'products.json');
    expect(page2.products.slice(0, 3).map((p) => p.product_id)).toEqual(
      full.products.slice(3, 6).map((p) => p.product_id),
    );
    expect(page2.products.at(-1)).toMatchObject({ product_id: '(other)', product_count: 5 });

    const search = await h.result<ProductsListResult>(
      experimentId,
      query(projectId, ...range, { search: 'merino' }),
    );
    expect(search.total_products).toBe(1);
    expect(search.products.map((p) => p.product_id)).toEqual(['P-TEE']);

    const detail = await h.result<ProductDetailResult>(
      experimentId,
      query(projectId, ...range, { product_id: 'P-RUN' }),
    );
    const run = full.products.find((p) => p.product_id === 'P-RUN');
    if (!run) throw new Error('P-RUN missing from the demo golden');
    expect(detail.product_id).toBe('P-RUN');
    expect(detail.variants.map((v) => v.item_variant)).toEqual(
      run.variants.map((v) => v.item_variant),
    );
    for (const v of ['100', '101', '102']) {
      const golden = run.by_variation[v];
      if (!golden) throw new Error(`P-RUN has no variation ${v}`);
      expect(detail.kpis.units_purchased[v]).toBe(golden.units_purchased);
      expect(detail.kpis.revenue_share[v]).toBe(golden.revenue_share);
      const shares = detail.variants.reduce((s, x) => s + (x.share[v] ?? 0), 0);
      expect(shares).toBeCloseTo(1, 5);
    }
  });

  it('400s through the route', async () => {
    const { projectId, experimentId } = await h.setup('f1', [100, 101]);
    const base = query(projectId, '2026-10-01', '2026-10-03');
    for (const [extra, field] of [
      [{ purchase_type: 'gift' }, 'purchase_type'],
      [{ sort: 'name' }, 'sort'],
      [{ limit: 0 }, 'limit'],
      [{ offset: -1 }, 'offset'],
      [{ product_id: '' }, 'product_id'],
    ] as const) {
      expect(await h.call('POST', `/${experimentId}/queries`, { ...base, ...extra })).toEqual({
        status: 400,
        body: { error: 'unknown_metric', field },
      });
    }
  });
});
