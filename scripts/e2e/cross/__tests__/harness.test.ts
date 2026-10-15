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
import { F1_DAILY_PURCHASE, F1_DASHBOARD, F1_PER_VARIATION, F1_QUALITY } from '../expected/f1.ts';
import { harnessRoot } from '../lib/args.ts';
import { deriveMetrics, sumByVariation } from '../lib/derive.ts';
import type { DailyRow } from '../lib/schemas.ts';
import { loadF1WireEvents } from '../shared/f1-wire.ts';
import { F3_COUNTS, buildF3WireEvents } from '../shared/f3-wire.ts';

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
