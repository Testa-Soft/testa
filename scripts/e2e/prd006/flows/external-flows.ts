/**
 * Flows that run other tools (006-validation.md V9, V10, V11):
 * - V9: the pixel Playwright spec (`apps/pixel/e2e/prd006.spec.ts`).
 * - V10: performance at 200k visitors / ~2M events. Heavy: runs only with
 *   PRD006_PERF=1 (a quiet machine; P6 / X1), otherwise reported `skipped`.
 * - V11: repo health (`pnpm -r typecheck && pnpm -r test && pnpm lint`) and
 *   the pixel bundle-size check.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../cross/lib/shell.ts';
import { REPO_ROOT } from '../config.ts';
import { generateF2 } from '../fixtures/f2-generator.ts';
import { ingestProject, publishConfig, simToWire } from '../ingest.ts';
import { type CheckFn, F1_KEYS, type FlowCtx, fail, pass, pending, skipped } from './types.ts';

const tail = (s: string, n = 6) => s.trim().split('\n').slice(-n).join(' ⏎ ');

/** P1's public pixel API the V9 spec drives; absent → the flow waits on P1. */
const PIXEL_P1_MARKERS = ['trackAddToCart', 'trackBeginCheckout', 'sessionIdx'];

function pixelHasP1(): boolean {
  const src = join(REPO_ROOT, 'apps', 'pixel', 'src');
  return PIXEL_P1_MARKERS.every((m) => Bun.spawnSync(['grep', '-rq', m, src]).exitCode === 0);
}

export async function v9(_ctx: FlowCtx, check: CheckFn): Promise<void> {
  await check(
    'pixel in a browser: sessions, exp, entry UTMs, click-id, track helpers, legacy cookies',
    async () => {
      if (!pixelHasP1()) {
        return pending(
          'P1',
          `pixel API not on this branch (${PIXEL_P1_MARKERS.join(', ')}); spec apps/pixel/e2e/prd006.spec.ts`,
        );
      }
      const res = await run(
        ['pnpm', '--filter', '@testa-platform/pixel', 'test:e2e', '-g', 'prd006'],
        { cwd: REPO_ROOT, timeoutMs: 600_000 },
      );
      const summary = /(\d+) passed|(\d+) failed/g;
      const counts = `${res.stdout}`.match(summary)?.join(', ') ?? 'no summary';
      return res.code === 0 ? pass(counts) : fail(`playwright: ${counts}; ${tail(res.stdout, 4)}`);
    },
  );
}

const PERF = { projectId: 900_048, experiment: 2001, days: 14, visitorsPerDay: 14_286 } as const;

const p95 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1] ?? Number.POSITIVE_INFINITY;

export async function v10(ctx: FlowCtx, check: CheckFn): Promise<void> {
  if (process.env.PRD006_PERF !== '1') {
    await check('performance (200k visitors / ~2M events)', async () =>
      skipped('heavy; set PRD006_PERF=1 on a quiet machine (P6 / X1)'),
    );
    return;
  }
  const { projectId, experiment } = PERF;
  const from = '2026-10-01';
  const to = '2026-10-14';
  await check('load 200k visitors through ingest', async () => {
    const sim = generateF2(projectId, { days: PERF.days, visitorsPerDay: PERF.visitorsPerDay });
    await publishConfig(ctx.cfg, projectId, [
      { id: experiment, variations: [300, 301, 302].map((id) => ({ id, weight: 1 })) },
    ]);
    const stats = await ingestProject(ctx.cfg, projectId, simToWire(sim));
    return pass(`${stats.accepted} events in ${(stats.ms / 1000).toFixed(0)} s`);
  });
  await check('full modeler run (22 keys, 14 days) < 120 s', async () => {
    const started = performance.now();
    await ctx.api.subscribe(experiment, { projectId, from, to, metrics: F1_KEYS });
    await ctx.api.waitReady(experiment, { timeoutMs: 600_000 });
    const s = (performance.now() - started) / 1000;
    return s < 120 ? pass(`${s.toFixed(1)} s`) : fail('run seconds', '< 120', s.toFixed(1));
  });
  await check('GET daily-summary p95 < 200 ms', async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) times.push((await ctx.api.summary(experiment)).res.ms);
    const v = p95(times);
    return v < 200 ? pass(`p95 ${v.toFixed(0)} ms`) : fail('p95 ms', '< 200', v.toFixed(0));
  });
  await check('summary query with one dimension < 60 s', async () => {
    const started = performance.now();
    await ctx.api.query(
      experiment,
      {
        view: 'summary',
        project_id: projectId,
        from,
        to,
        report_currency: 'EUR',
        metrics: ['purchase', 'revenue'],
        dimension: 'city',
      },
      300_000,
    );
    const s = (performance.now() - started) / 1000;
    return s < 60 ? pass(`${s.toFixed(1)} s`) : fail('seconds', '< 60', s.toFixed(1));
  });
  await check('stats endpoint (20 metrics × 3 variations) p95 < 300 ms', async () => {
    const metrics = Array.from({ length: 20 }, (_, i) => ({
      key: `m${i}`,
      model: 'beta',
      variations: [100, 101, 102].map((v, k) => ({
        variation: v,
        n: 4700 + 40 * k,
        x: 110 + 10 * k + i,
      })),
    }));
    const times: number[] = [];
    for (let i = 0; i < 23; i++) {
      const res = await ctx.api.stats({ control: 100, metrics });
      if (i >= 3) times.push(res.ms);
    }
    const v = p95(times);
    return v < 300 ? pass(`p95 ${v.toFixed(0)} ms`) : fail('p95 ms', '< 300', v.toFixed(0));
  });
}

export async function v11(_ctx: FlowCtx, check: CheckFn): Promise<void> {
  for (const [name, cmd] of [
    ['pnpm -r typecheck', ['pnpm', '-r', 'typecheck']],
    ['pnpm -r test', ['pnpm', '-r', 'test']],
    ['pnpm lint', ['pnpm', 'lint']],
    ['pixel bundle size', ['pnpm', '--filter', '@testa-platform/pixel', 'check:size']],
  ] as const) {
    await check(name, async () => {
      const res = await run([...cmd], { cwd: REPO_ROOT, timeoutMs: 900_000 });
      return res.code === 0
        ? pass('exit 0')
        : fail(`exit ${res.code}: ${tail(`${res.stdout}\n${res.stderr}`)}`);
    });
  }
}

/** Plan line for `--dry-run`: does the repo have what each external flow needs? */
export function externalNotes(): Record<string, string> {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'apps', 'pixel', 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  return {
    V9: pixelHasP1()
      ? 'pixel P1 API present → runs playwright -g prd006'
      : 'pending-P1 (pixel API missing)',
    V10: process.env.PRD006_PERF === '1' ? 'runs (PRD006_PERF=1)' : 'skipped (set PRD006_PERF=1)',
    V11: pkg.scripts?.['check:size']
      ? 'typecheck + test + lint + pixel check:size'
      : 'pixel check:size script missing',
  };
}
