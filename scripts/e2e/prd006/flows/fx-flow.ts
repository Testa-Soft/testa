/**
 * V17 FX (006-validation.md): orders convert at the PREVIOUS UTC day's rate,
 * a weekend order uses Friday's rate, a missing day falls back to the last
 * known rate. Own project + dates in September 2026 (before the harness's
 * constant seed starts on 09-20), with hand-picked USD→EUR rates:
 *
 *   Thu 09-03 0.82 · Fri 09-04 0.84 · (Sat/Sun none) · Mon 09-07 0.86 · (Tue 09-08 none)
 *
 * One USD 100.00 order per date: Fri 09-04 → Thu 0.82 = 82.00;
 * Sun 09-06 → Fri 0.84 = 84.00; Wed 09-09 → Mon 0.86 = 86.00.
 * Plus F1: v2's USD 50 order (D1) at 0.9 → variant D1 purchase sum 125.00.
 */

import { chCommand } from '../../cross/lib/clickhouse.ts';
import type { WireEvent } from '../../cross/shared/f1-wire.ts';
import { FX_FIXTURE } from '../config.ts';
import { wireEvent } from '../fixtures/wire.ts';
import { ingestProject, publishConfig } from '../ingest.ts';
import type { SummaryBody } from './api.ts';
import { type CheckFn, Diff, type FlowCtx, fact } from './types.ts';

const RATES = [
  ['2026-09-01', 0.8],
  ['2026-09-03', 0.82],
  ['2026-09-04', 0.84],
  ['2026-09-07', 0.86],
] as const;
export const FX_ORDERS = [
  { date: '2026-09-04', expected: 82.0, why: 'Friday order → Thursday rate' },
  { date: '2026-09-06', expected: 84.0, why: 'Sunday order → Friday rate (weekend)' },
  { date: '2026-09-09', expected: 86.0, why: 'Wednesday order, Tuesday missing → Monday rate' },
] as const;

function events(): WireEvent[] {
  const { projectId, experiment } = FX_FIXTURE;
  return FX_ORDERS.flatMap(({ date }, i) => {
    const view = Date.parse(`${date}T12:00:00Z`);
    const visitor = `fx-${i}`;
    const exp = [[experiment, 100, Math.floor(view / 1000), 1]];
    return [
      wireEvent(projectId, visitor, 'experiment_view', view, {
        exp,
        experiment_id: experiment,
        variation_id: 100,
      }),
      wireEvent(projectId, visitor, 'purchase', view + 60_000, {
        exp,
        order_id: `FX-${i}`,
        purchase_type: 'initial',
        value_native: 100,
        currency: 'USD',
        items_count: 1,
        items: [{ item_id: 'SKU-FX', product_id: 'SKU-FX', price: 100, quantity: 1 }],
      }),
    ];
  });
}

export async function v17(ctx: FlowCtx, check: CheckFn): Promise<void> {
  const { projectId, experiment } = FX_FIXTURE;

  await check('previous-day rate, weekend → Friday, missing day → last known', async () => {
    const rows = RATES.flatMap(([date, eur]) => [
      `('${date}','USD','EUR',${eur})`,
      `('${date}','USD','USD',1)`,
    ]);
    await chCommand(
      ctx.cfg.ch,
      `INSERT INTO fx_rates_history (date, from_ccy, to_ccy, rate) VALUES ${rows.join(',')}`,
    );
    await publishConfig(ctx.cfg, projectId, [
      {
        id: experiment,
        variations: [
          { id: 100, weight: 50 },
          { id: 101, weight: 50 },
        ],
      },
    ]);
    await ingestProject(ctx.cfg, projectId, events());
    await ctx.api.subscribe(experiment, {
      projectId,
      from: '2026-09-01',
      to: '2026-09-10',
      status: 'stopped',
      metrics: ['purchase'],
    });
    const s = await ctx.api.waitReady(experiment);
    const d = new Diff();
    for (const o of FX_ORDERS) {
      const row = s.rows.find(
        (r) => r.date === o.date && r.metric_key === 'purchase' && r.variation_id === 100,
      );
      d.near(`${o.date} (${o.why})`, o.expected, row?.sum ?? null, 0.005);
    }
    return d.outcome('3 conversions');
  });

  await check(
    "F1: v2's USD 50 order converts at the previous day's 0.9 (variant D1 purchase sum 125.00)",
    async () => {
      const s = fact<SummaryBody>(ctx, 'f1.summary.1717');
      const row = s.rows.find(
        (r) => r.date === '2026-10-01' && r.variation_id === 101 && r.metric_key === 'purchase',
      );
      return new Diff()
        .near('D1 101 purchase sum', 125.0, row?.sum ?? null, 0.005)
        .outcome('45.00 + 80.00');
    },
  );
}
