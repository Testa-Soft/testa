#!/usr/bin/env bun
/**
 * `pnpm prd006:validate [--only F1|V4|…] [--keep-up] [--dry-run] [--port N] [--no-compose] [--down]`
 * (task 5.14): bring up the local stack, load fixtures F1–F3 through the real
 * ingest path, subscribe them and wait for `ready`, run the flows in
 * `docs/prds/006-validation.md`, write `docs/prds/006-validation-report.md`,
 * tear down (unless --keep-up), exit non-zero on any failure.
 *
 * Env: PRD006_CLICKHOUSE_DATABASE (default prd006_validate), PRD006_REDIS_URL
 * (default redis://localhost:6380/12; collector tests flush DBs 7–11), PRD006_PERF=1 for V10.
 */

import { log } from '../cross/lib/log.ts';
import { run as sh } from '../cross/lib/shell.ts';
import {
  CONTRACT,
  FIXTURES,
  type FixtureId,
  type HarnessConfig,
  buildConfig,
  parseArgs,
} from './config.ts';
import { SAMPLES_DIR } from './config.ts';
import { F1_FROM, f1WireEvents } from './fixtures/f1.ts';
import { F2_EXPERIMENTS, F2_FROM, F2_TO, generateF2 } from './fixtures/f2-generator.ts';
import { F3_COUNTS, F3_DATE, F3_EXPERIMENT, f3WireEvents } from './fixtures/f3-golden.ts';
import { FLOWS, runFlow, select } from './flows.ts';
import { syncApi } from './flows/api.ts';
import { externalNotes } from './flows/external-flows.ts';
import { F1_KEYS, F2_KEYS, type FlowCtx, type FlowResult } from './flows/types.ts';
import { ingestProject, publishConfig, simToWire } from './ingest.ts';
import { buildModel, dailySummary } from './oracle.ts';
import { loadSampleSim } from './raw.ts';
import { flowStatus, writeReport } from './report.ts';
import { stackDown, stackUp, startWebhookReceiver } from './stack.ts';

const equalWeights = (ids: readonly number[]) => ids.map((id) => ({ id, weight: 1 }));

// ─── fixtures ───────────────────────────────────────────────────────────────

async function loadF1(ctx: FlowCtx): Promise<string> {
  const { projectId, experiments } = FIXTURES.F1;
  const [e1717, e1802] = experiments;
  await publishConfig(ctx.cfg, projectId, [
    {
      id: e1717,
      variations: [
        { id: 100, weight: 50 },
        { id: 101, weight: 50 },
      ],
    },
    {
      id: e1802,
      variations: [
        { id: 200, weight: 50 },
        { id: 201, weight: 50 },
      ],
    },
  ]);
  const { events } = f1WireEvents();
  const stats = await ingestProject(ctx.cfg, projectId, events);
  ctx.facts.set('f1.wire', events);
  for (const exp of experiments) {
    await ctx.api.subscribe(exp, { projectId, from: F1_FROM, to: null, metrics: F1_KEYS });
    ctx.facts.set(`f1.summary.${exp}`, await ctx.api.waitReady(exp));
  }
  return `F1: ${stats.accepted} events ingested (${stats.batches} batch), 1717 + 1802 ready`;
}

async function loadF2(ctx: FlowCtx): Promise<string> {
  const { projectId } = FIXTURES.F2;
  const sim = generateF2(projectId);
  await publishConfig(
    ctx.cfg,
    projectId,
    F2_EXPERIMENTS.map((e) => ({ id: e.id, variations: equalWeights(e.variations) })),
  );
  const stats = await ingestProject(ctx.cfg, projectId, simToWire(sim));
  for (const e of F2_EXPERIMENTS) {
    const variations = [...e.variations];
    ctx.facts.set(
      `f2.model.${e.id}`,
      buildModel(
        sim,
        e.id,
        F2_FROM,
        F2_TO,
        variations,
        variations.map(() => 1 / variations.length),
      ),
    );
    await ctx.api.subscribe(e.id, {
      projectId,
      from: F2_FROM,
      to: F2_TO,
      status: 'stopped',
      metrics: F2_KEYS,
    });
  }
  for (const e of F2_EXPERIMENTS)
    ctx.facts.set(`f2.summary.${e.id}`, await ctx.api.waitReady(e.id, { timeoutMs: 600_000 }));
  ctx.facts.set('f2.sim', sim);
  return `F2: ${stats.accepted} events in ${(stats.ms / 1000).toFixed(0)} s, 2001 + 2002 ready`;
}

async function loadF3(ctx: FlowCtx): Promise<string> {
  const { projectId } = FIXTURES.F3;
  await publishConfig(ctx.cfg, projectId, [
    { id: F3_EXPERIMENT, variations: equalWeights(F3_COUNTS.map((c) => c.variation)) },
  ]);
  const stats = await ingestProject(ctx.cfg, projectId, f3WireEvents());
  await ctx.api.subscribe(F3_EXPERIMENT, {
    projectId,
    from: F3_DATE,
    to: F3_DATE,
    status: 'stopped',
    metrics: ['purchase'],
  });
  ctx.facts.set('f3.summary.1903', await ctx.api.waitReady(F3_EXPERIMENT));
  return `F3: ${stats.accepted} events, 1903 ready`;
}

const LOADERS: Record<FixtureId, (ctx: FlowCtx) => Promise<string>> = {
  F1: loadF1,
  F2: loadF2,
  F3: loadF3,
};

async function publishContract(cfg: HarnessConfig): Promise<void> {
  await publishConfig(cfg, CONTRACT.projectId, [
    { id: CONTRACT.emptyV2, variations: equalWeights([100, 101]) },
    { id: CONTRACT.legacyV1, variations: equalWeights([100, 101]), version: 'v1' },
  ]);
}

// ─── dry run ────────────────────────────────────────────────────────────────

function dryRun(cfg: HarnessConfig): void {
  const sel = select(cfg.args.only);
  const f1 = f1WireEvents();
  const m1 = buildModel(
    loadSampleSim(SAMPLES_DIR, 'f1'),
    1717,
    '2026-10-01',
    '2026-10-03',
    [100, 101],
    [0.5, 0.5],
  );
  const f2 = generateF2(FIXTURES.F2.projectId);
  const f2Rows = F2_EXPERIMENTS.map((e) => {
    const v = [...e.variations];
    return `${e.id}: ${
      dailySummary(
        buildModel(
          f2,
          e.id,
          F2_FROM,
          F2_TO,
          v,
          v.map(() => 1 / v.length),
        ),
        { keys: F2_KEYS },
      ).rows.length
    } oracle rows`;
  });
  const visitors = new Set(f2.events.map((e) => e.visitor_id)).size;
  const notes = externalNotes();
  const plan = [
    'prd006:validate --dry-run (nothing started)',
    `stack: ClickHouse ${cfg.ch.url}/${cfg.ch.database} (dropped + migrated), Redis ${cfg.redisUrl}, collector :${cfg.args.port}, consumer, modeler; webhook receiver :${cfg.webhookPort}`,
    `fixtures to load: ${[...sel.fixtures].join(', ') || 'none'}`,
    `  F1: ${f1.events.length} wire events, ${f1.itemRows} item rows → project ${FIXTURES.F1.projectId}; oracle ${dailySummary(m1).rows.length} daily rows`,
    `  F2: seed 1717, ${visitors} visitors, ${f2.events.length} events, ${f2.items.length} item rows → project ${FIXTURES.F2.projectId}; ${f2Rows.join(', ')}`,
    `  F3: ${f3WireEvents().length} wire events → project ${FIXTURES.F3.projectId}, experiment ${F3_EXPERIMENT}`,
    'flows (execution order):',
    ...sel.flows.map(
      (f) => `  ${f.id.padEnd(4)} ${f.title} [${f.data}]${notes[f.id] ? ` — ${notes[f.id]}` : ''}`,
    ),
    `report → ${cfg.args.reportPath}`,
  ];
  console.log(plan.join('\n'));
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = buildConfig(args);
  if (args.dryRun) {
    dryRun(cfg);
    return 0;
  }
  if (args.down) {
    await stackDown(cfg);
    return 0;
  }
  const started = new Date();
  const sel = select(args.only);
  const setup: string[] = [];
  const webhooks = startWebhookReceiver(cfg);
  const ctx: FlowCtx = { cfg, api: syncApi(cfg), webhooks, facts: new Map() };
  const results: FlowResult[] = [];
  try {
    const info = await stackUp(cfg);
    setup.push(
      `ClickHouse \`${cfg.ch.database}\` fresh (${info.migrations} migrations), Redis \`${cfg.redisUrl}\`, collector :${args.port}, modeler ${info.modelerAlive ? 'running' : 'NOT running'}`,
    );
    if (sel.flows.some((f) => f.id === 'V8')) await publishContract(cfg);
    for (const id of ['F1', 'F2', 'F3'] as const) {
      if (!sel.fixtures.has(id)) continue;
      log(`loading ${id}…`);
      try {
        setup.push(await LOADERS[id](ctx));
      } catch (err) {
        setup.push(`${id} FAILED to load: ${(err as Error).message}`);
        log(`${id} failed to load: ${(err as Error).message}`);
      }
    }
    for (const def of sel.flows) {
      log(`${def.id} ${def.title}`);
      const r = await runFlow(def, ctx, (c) =>
        log(
          `  ${c.status.padEnd(7)} ${c.name}${c.status === 'pass' ? '' : ` — ${c.detail.slice(0, 160)}`}`,
        ),
      );
      results.push(r);
    }
  } catch (err) {
    setup.push(`STACK FAILED: ${(err as Error).message}`);
    log(`stack failed: ${(err as Error).message}`);
  } finally {
    webhooks.stop();
    if (!args.keepUp) await stackDown(cfg);
    else log(`--keep-up: stack left running on :${args.port}`);
  }
  const commit = (await sh(['git', 'rev-parse', '--short', 'HEAD'])).stdout.trim();
  writeReport(args.reportPath, results, {
    startedAt: started,
    ms: Date.now() - started.getTime(),
    commit,
    args: process.argv.slice(2).join(' '),
    setup,
  });
  const failed = results.filter((r) => flowStatus(r) === 'fail').map((r) => r.id);
  const stackBroken = setup.some(
    (s) => s.startsWith('STACK FAILED') || s.includes('FAILED to load'),
  );
  log(`report → ${args.reportPath}`);
  log(`flows: ${results.map((r) => `${r.id}:${flowStatus(r)}`).join(' ')}`);
  return failed.length > 0 || stackBroken ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}

export { FLOWS };
