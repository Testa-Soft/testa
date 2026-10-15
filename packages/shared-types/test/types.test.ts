import { describe, expect, test } from 'bun:test';
import type {
  DailySummaryResponse,
  DimensionKey,
  ExperimentConfig,
  MetricKey,
  PixelEvent,
  QueryResponse,
  SummaryResult,
} from '../src/index.ts';
import { BUILTIN_METRIC_KEYS, DIMENSION_KEYS, EVENT_PARAM_SPEC } from '../src/index.ts';
import { type Equal, accepts, assertType } from './type-assert.ts';

describe('MetricKey', () => {
  test('accepts built-ins, event:<name> and goal:<id>; rejects unknown keys', () => {
    accepts<MetricKey>('purchase');
    accepts<MetricKey>('units_bought_from_cart');
    accepts<MetricKey>('event:size_guide_opened');
    accepts<MetricKey>('goal:12');
    // @ts-expect-error unknown built-in key
    accepts<MetricKey>('aov');
    // @ts-expect-error goal id must be numeric
    accepts<MetricKey>('goal:abc');
    // @ts-expect-error prefix without separator
    accepts<MetricKey>('eventfoo');
    expect(BUILTIN_METRIC_KEYS).toHaveLength(20);
    expect(new Set(BUILTIN_METRIC_KEYS).size).toBe(20);
  });
});

describe('QueryResponse', () => {
  test('narrows rows vs result by view', () => {
    const narrow = (r: QueryResponse): number => {
      switch (r.view) {
        case 'summary':
          // @ts-expect-error summary has no `result`
          void r.result;
          return r.rows.length;
        case 'products':
          // @ts-expect-error views have no `rows`
          void r.rows;
          return r.result === null ? 0 : 1;
        case 'distributions':
        case 'health':
          return r.result === null ? 0 : 1;
      }
    };
    expect(
      narrow({
        view: 'summary',
        query_id: 'q',
        status: 'not_ready',
        retry_after: 5,
        computed_at: null,
        rows: [],
        dimension: null,
        cap_outliers: false,
        quality: null,
      }),
    ).toBe(0);
  });
});

describe('summary shapes', () => {
  test('dimension rows only with a dimension', () => {
    const base = {
      experiment_id: 1,
      from: '2026-10-01',
      to: '2026-10-02',
      report_currency: 'EUR',
      date_basis: 'first_exposure',
      cap_outliers: false,
      quality: { multi_variation_visitors: 0, variation_mismatch_events: 0 },
    } as const;
    accepts<SummaryResult>({ ...base, dimension: null, rows: [] });
    accepts<SummaryResult>({ ...base, dimension: 'device_type', rows: [] });
    accepts<SummaryResult>({
      ...base,
      dimension: null,
      // @ts-expect-error a plain summary carries no dimension rows
      rows: [{ ...row(), dimension: 'device_type', dimension_value: 'mobile' }],
    });
    assertType<Equal<DailySummaryResponse['dimension'], null>>();
  });

  test('DIMENSION_KEYS matches DimensionKey', () => {
    assertType<Equal<(typeof DIMENSION_KEYS)[number], DimensionKey>>();
    expect(DIMENSION_KEYS).not.toContain('ip');
  });
});

describe('event envelope', () => {
  test('exp tuple and v2 platform_version', () => {
    assertType<Equal<PixelEvent['exp'], [number, number, number, number][]>>();
    assertType<Equal<ExperimentConfig['platform_version'], 'v1' | 'v2' | undefined>>();
    accepts<PixelEvent['purchase_type']>('upsell');
    // @ts-expect-error only initial | upsell
    accepts<PixelEvent['purchase_type']>('recurring');
  });

  test('EVENT_PARAM_SPEC follows PRD §6.5', () => {
    expect(EVENT_PARAM_SPEC.purchase).toContain('items[].quantity');
    expect(EVENT_PARAM_SPEC.add_payment_info).toEqual(['payment_type']);
    expect(EVENT_PARAM_SPEC.begin_checkout).toEqual([]);
  });
});

function row() {
  return {
    date: '2026-10-01',
    variation_id: 100,
    metric_key: 'purchase',
    visitors: 1,
    converted: 1,
    count: 1,
    sum: 1,
    sum_sq: 1,
    sum_sq_visitor: 1,
  } as const;
}
