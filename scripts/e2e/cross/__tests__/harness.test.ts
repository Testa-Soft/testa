/**
 * Self-tests for the harness's own logic (no live systems): the F1 golden rows,
 * fed through the harness's derivation, must reproduce the literal F1 tables —
 * otherwise a live failure could be the harness's fault. Also pins the wire
 * encoding of F1 / F3.
 *
 *   bun test scripts/e2e/cross
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareRows } from '../checks/contract-sync.ts';
import { crobotVariationPk } from '../checks/sync-support.ts';
import {
  F1_DAILY_PURCHASE,
  F1_DASHBOARD,
  F1_METRICS,
  F1_PER_VARIATION,
  F1_QUALITY,
} from '../expected/f1.ts';
import { harnessRoot } from '../lib/args.ts';
import { deriveMetrics, sumByVariation } from '../lib/derive.ts';
import type { DailyRow } from '../lib/schemas.ts';
import { loadF1WireEvents } from '../shared/f1-wire.ts';
import { F3_COUNTS, buildF3WireEvents } from '../shared/f3-wire.ts';
import {
  TENANT_COUNTS,
  buildTenantWireEvents,
  tenantProjectSource,
} from '../shared/tenant-wire.ts';

const golden = JSON.parse(
  readFileSync(join(harnessRoot, 'docs/reference/samples/f1/modeled/daily_summary.json'), 'utf8'),
) as { rows: DailyRow[]; quality: unknown };

describe('F1 golden → harness derivation', () => {
  const sums = sumByVariation(golden.rows);

  for (const variation of [100, 101] as const) {
    test(`variation ${variation} reproduces the per-variation and dashboard tables`, () => {
      const v = sums.get(variation);
      expect(v).toBeDefined();
      const got = deriveMetrics(v as NonNullable<typeof v>);
      for (const [k, want] of Object.entries({
        ...F1_PER_VARIATION[variation],
        ...F1_DASHBOARD[variation],
      })) {
        if (want === null) expect(got[k]).toBeNull();
        else expect(Math.abs((got[k] as number) - want)).toBeLessThanOrEqual(1e-6);
      }
    });
  }

  test('quality and daily purchase rows', () => {
    expect(golden.quality).toEqual(F1_QUALITY);
    const purchase = golden.rows
      .filter((r) => r.metric_key === 'purchase')
      .map((r) => ({
        date: r.date,
        variation_id: r.variation_id,
        visitors: r.visitors,
        converted: r.converted,
      }));
    expect(purchase).toEqual([...F1_DAILY_PURCHASE]);
  });

  test('F1_METRICS (what the harness subscribes) is exactly the golden key set (R2 units_upsell included)', () => {
    expect(new Set<string>(F1_METRICS)).toEqual(new Set(golden.rows.map((r) => r.metric_key)));
  });

  test('compareRows: identical → no diff; a changed count and an extra row are reported', () => {
    expect(compareRows(golden.rows, golden.rows).ok).toBe(true);
    const [first, ...rest] = golden.rows;
    const changed = [
      { ...(first as DailyRow), converted: 99 },
      ...rest,
      { ...(first as DailyRow), metric_key: 'x' },
    ];
    const diff = compareRows(golden.rows, changed);
    expect(diff.list.length).toBe(2);
  });
});

describe('wire fixtures', () => {
  const f1 = loadF1WireEvents(harnessRoot);

  test('F1: 29 events, 11 item rows, v3 return is session_idx 2', () => {
    expect(f1.events.length).toBe(29);
    expect(f1.itemRows).toBe(11);
    const v3 = f1.events.filter((e) => e.visitor_id === 'v3' && e.event_name === 'experiment_view');
    expect(v3.map((e) => (e.exp as number[][])[0]?.[3])).toEqual([1, 2]);
  });

  test('F1: v6 purchase has empty exp; v2 upsell keeps parent_order_id; v8 item has no price', () => {
    const v6 = f1.events.find((e) => e.visitor_id === 'v6' && e.event_name === 'purchase');
    expect(v6?.exp).toEqual([]);
    const upsell = f1.events.find((e) => e.order_id === 'O2-U1');
    expect(upsell?.parent_order_id).toBe('O2');
    const v8 = f1.events.find((e) => e.visitor_id === 'v8' && e.event_name === 'add_to_cart');
    expect((v8?.items as { price?: number }[])[0]?.price).toBeUndefined();
  });

  test('F3: exact visitor and purchaser counts', () => {
    const events = buildF3WireEvents(42, 1903);
    for (const { variation, visitors, purchasers } of F3_COUNTS) {
      const views = events.filter(
        (e) => e.event_name === 'experiment_view' && e.variation_id === variation,
      );
      const buys = events.filter(
        (e) => e.event_name === 'purchase' && (e.exp as number[][])[0]?.[1] === variation,
      );
      expect(views.length).toBe(visitors);
      expect(buys.length).toBe(purchasers);
    }
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
  });
});

describe('R3 tenant fixture + crobot id mapping', () => {
  test('tenant project: exact visitors / purchasers, its own project id, unique event ids', () => {
    const events = buildTenantWireEvents(43, 1717);
    for (const { variation, visitors, purchasers } of TENANT_COUNTS) {
      const views = events.filter(
        (e) => e.event_name === 'experiment_view' && e.variation_id === variation,
      );
      const buys = events.filter(
        (e) => e.event_name === 'purchase' && (e.exp as number[][])[0]?.[1] === variation,
      );
      expect(views.length).toBe(visitors);
      expect(buys.length).toBe(purchasers);
    }
    expect(events.every((e) => e.project_id === 43)).toBe(true);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    // Never the F1 project's event ids (same identifier, different project).
    const f1Ids = new Set(loadF1WireEvents(harnessRoot).events.map((e) => e.event_id));
    expect(events.some((e) => f1Ids.has(e.event_id))).toBe(false);
  });

  test('tenant config source reuses the identifier as a v2 experiment', () => {
    expect(tenantProjectSource(43, 1717)).toMatchObject({
      id: 43,
      experiments: [{ identifier: 1717, platform_version: 'v2' }],
    });
  });

  test('crobot variation PK is per experiment (101 is 6002 in 1717, 6006 in 1903)', () => {
    expect(crobotVariationPk(1717, 101)).toBe(6002);
    expect(crobotVariationPk(1903, 101)).toBe(6006);
    expect(crobotVariationPk(1802, 200)).toBe(6003);
    expect(() => crobotVariationPk(1903, 999)).toThrow();
  });
});
