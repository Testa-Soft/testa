/**
 * Stats flows (006-validation.md V7, V15). V7 feeds the endpoint the F3 sums
 * the platform itself modeled (daily-summary → Σ per variation), so the path
 * crobot uses is what's checked. V15 checks SRM through the health view and
 * the planning helper by running the stats module in a child process (the
 * harness never imports collector source).
 */

import { sumByVariation } from '../../cross/lib/derive.ts';
import { run } from '../../cross/lib/shell.ts';
import { FIXTURES } from '../config.ts';
import { F3_DATE, F3_EXPERIMENT, F3_PLANNING, F3_SRM, F3_STATS } from '../fixtures/f3-golden.ts';
import type { SummaryBody } from './api.ts';
import { type CheckFn, Diff, type FlowCtx, fact, fail, pass } from './types.ts';

type StatsBody = { metrics?: Record<string, Record<string, Record<string, unknown>>> };

function f3Variations(ctx: FlowCtx) {
  const sums = sumByVariation(fact<SummaryBody>(ctx, 'f3.summary.1903').rows);
  return [...sums].map(([variation, s]) => ({
    variation,
    n: s.visitors,
    x: s.keys.get('purchase')?.converted ?? 0,
  }));
}

const inRange = (x: unknown, [lo, hi]: readonly [number, number]) =>
  typeof x === 'number' && x >= lo && x <= hi;

export async function v7(ctx: FlowCtx, check: CheckFn): Promise<void> {
  const body = () => ({
    control: 100,
    metrics: [{ key: 'purchase', model: 'beta', variations: f3Variations(ctx) }],
  });

  await check(
    'F3 sums from the platform: 4,737 / 4,790 / 4,702 visitors, 115 / 137 / 109 purchasers',
    async () => {
      const got = f3Variations(ctx).map((v) => [v.variation, v.n, v.x]);
      return new Diff()
        .eq(
          'sums',
          [
            [100, 4737, 115],
            [101, 4790, 137],
            [102, 4702, 109],
          ],
          got,
        )
        .outcome('modeled sums exact');
    },
  );

  await check(
    'variation 101: chance to beat ∈ [0.902, 0.912], best ∈ [0.871, 0.881]; control has only chance_to_be_best',
    async () => {
      const res = await ctx.api.stats(body());
      if (res.status !== 200)
        return fail(`POST /api/v1/stats → ${res.status}: ${res.text.slice(0, 200)}`);
      const m = (res.json as StatsBody).metrics?.purchase ?? {};
      const v101 = m['101'] ?? {};
      return new Diff()
        .truthy(
          'chance_to_beat_control',
          inRange(v101.chance_to_beat_control, F3_STATS.chance_to_beat),
          String(v101.chance_to_beat_control),
        )
        .truthy(
          'chance_to_be_best',
          inRange(v101.chance_to_be_best, F3_STATS.chance_to_be_best),
          String(v101.chance_to_be_best),
        )
        .eq('control keys', ['chance_to_be_best'], Object.keys(m['100'] ?? {}))
        .outcome(
          `beat ${String(v101.chance_to_beat_control)}, best ${String(v101.chance_to_be_best)}`,
        );
    },
  );

  await check('identical calls are byte-identical', async () => {
    const [a, b] = [await ctx.api.stats(body()), await ctx.api.stats(body())];
    return a.text === b.text && a.status === 200
      ? pass(`${a.text.length} bytes`)
      : fail('responses differ');
  });

  await check('< 100 visitors → insufficient_data', async () => {
    const res = await ctx.api.stats({
      control: 100,
      metrics: [
        {
          key: 'purchase',
          model: 'beta',
          variations: [
            { variation: 100, n: 4737, x: 115 },
            { variation: 101, n: 99, x: 12 },
          ],
        },
      ],
    });
    const v = (res.json as StatsBody).metrics?.purchase?.['101'];
    return v?.insufficient_data === true ? pass('flagged') : fail('insufficient_data', true, v);
  });

  await check('control: 101 flips the reference', async () => {
    const res = await ctx.api.stats({ ...body(), control: 101 });
    const m = (res.json as StatsBody).metrics?.purchase ?? {};
    return new Diff()
      .eq('101 keys', ['chance_to_be_best'], Object.keys(m['101'] ?? {}))
      .truthy(
        '100 chance_to_beat_control < 0.1',
        typeof m['100']?.chance_to_beat_control === 'number' &&
          (m['100'].chance_to_beat_control as number) < 0.1,
      )
      .outcome('flipped');
  });

  await check('F2: every variation of summed purchase / revenue rows gets stats', async () => {
    const rows = fact<SummaryBody>(ctx, `f2.summary.${FIXTURES.F2.experiments[0]}`).rows;
    const sums = sumByVariation(rows);
    const sumSqVisitor = (v: number) =>
      rows
        .filter((r) => r.variation_id === v && r.metric_key === 'revenue')
        .reduce((t, r) => t + r.sum_sq_visitor, 0);
    const variations = [...sums.keys()];
    const res = await ctx.api.stats({
      control: variations[0],
      metrics: [
        {
          key: 'cr',
          model: 'beta',
          variations: [...sums].map(([v, s]) => ({
            variation: v,
            n: s.visitors,
            x: s.keys.get('purchase')?.converted ?? 0,
          })),
        },
        {
          key: 'rpv',
          model: 'normal',
          variations: [...sums].map(([v, s]) => ({
            variation: v,
            n: s.visitors,
            sum: s.keys.get('revenue')?.sum ?? 0,
            sumSq: sumSqVisitor(v),
          })),
        },
      ],
    });
    if (res.status !== 200) return fail(`→ ${res.status}: ${res.text.slice(0, 200)}`);
    const m = (res.json as StatsBody).metrics ?? {};
    return new Diff()
      .eq('cr variations', variations.map(String).sort(), Object.keys(m.cr ?? {}).sort())
      .eq('rpv variations', variations.map(String).sort(), Object.keys(m.rpv ?? {}).sort())
      .outcome(`${variations.length} variations`);
  });
}

export async function v15(ctx: FlowCtx, check: CheckFn): Promise<void> {
  await check('SRM on F3 (health view): χ² 0.8277, p 0.6611 (±0.001), ok', async () => {
    const res = await ctx.api.query(F3_EXPERIMENT, {
      view: 'health',
      project_id: FIXTURES.F3.projectId,
      from: F3_DATE,
      to: F3_DATE,
      report_currency: 'EUR',
    });
    const srm = (res.result as { srm: { chi2: number; p_value: number; ok: boolean } }).srm;
    return new Diff()
      .near('chi2', F3_SRM.chi2, srm.chi2, F3_SRM.tolerance)
      .near('p_value', F3_SRM.p_value, srm.p_value, F3_SRM.tolerance)
      .eq('ok', F3_SRM.ok, srm.ok)
      .outcome(`χ² ${srm.chi2.toFixed(4)}, p ${srm.p_value.toFixed(4)}`);
  });

  await check(
    'planning: baseline 0.024277, mde 0.15, α 0.05, power 0.8 → 30,084 ± 1 (stats module, child process)',
    async () => {
      const script = `import { sampleSizeTwoProportion } from './src/stats/index.ts';
      console.log(sampleSizeTwoProportion({ baseline: ${F3_PLANNING.baseline}, mde: ${F3_PLANNING.mde}, alpha: 0.05, power: 0.8 }));`;
      const out = await run(['bun', '-e', script], { cwd: ctx.cfg.collectorDir });
      if (out.code !== 0) return fail(`bun -e exited ${out.code}: ${out.stderr.slice(0, 200)}`);
      const planned = Number(out.stdout.trim());
      return Math.abs(planned - F3_PLANNING.planned) <= F3_PLANNING.tolerance
        ? pass(`${planned}`)
        : fail('planned sample', F3_PLANNING.planned, planned);
    },
  );
}
