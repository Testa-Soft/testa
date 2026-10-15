/**
 * The PRD-006 validation flows (006-validation.md "Validation flows"): the
 * registry, which fixtures each needs, the execution order, and the runner
 * that turns each check into pass / fail / pending / skipped with timings.
 */

import { errorMessage } from '../cross/lib/log.ts';
import type { FixtureId, FlowId } from './config.ts';
import { v8, v16 } from './flows/contract-flows.ts';
import { v9, v10, v11 } from './flows/external-flows.ts';
import { v1, v2, v3, v5F1, v12F1, v13F1, v14 } from './flows/f1-flows.ts';
import { v4, v5F2, v6, v12F2, v13F2 } from './flows/f2-flows.ts';
import { v17 } from './flows/fx-flow.ts';
import { v7, v15 } from './flows/stats-flows.ts';
import {
  type CheckFn,
  type CheckResult,
  FixtureNotLoaded,
  type FlowCtx,
  type FlowDef,
  type FlowResult,
} from './flows/types.ts';

const both =
  (...parts: ((ctx: FlowCtx, check: CheckFn) => Promise<void>)[]) =>
  async (ctx: FlowCtx, check: CheckFn) => {
    for (const part of parts) await part(ctx, check);
  };

export const FLOWS: readonly FlowDef[] = [
  { id: 'V1', title: 'Ingest round-trip', data: 'F1', fixtures: ['F1'], run: v1 },
  { id: 'V2', title: 'Attribution rules', data: 'F1', fixtures: ['F1'], run: v2 },
  { id: 'V3', title: 'Returning visitor + dates', data: 'F1', fixtures: ['F1'], run: v3 },
  { id: 'V4', title: 'Full metric keys', data: 'F2', fixtures: ['F2'], run: v4 },
  {
    id: 'V5',
    title: 'Dedup + upsell',
    data: 'F1 + F2',
    fixtures: ['F1', 'F2'],
    run: both(v5F1, v5F2),
  },
  { id: 'V6', title: 'Dimensions + folding', data: 'F2', fixtures: ['F2'], run: v6 },
  { id: 'V7', title: 'Stats endpoint', data: 'F3 + F2', fixtures: ['F3', 'F2'], run: v7 },
  { id: 'V8', title: 'API contract', data: '—', fixtures: [], run: v8 },
  { id: 'V9', title: 'Pixel in a browser', data: 'fixture page', fixtures: [], run: v9 },
  { id: 'V10', title: 'Performance', data: 'generated 200k visitors', fixtures: [], run: v10 },
  { id: 'V11', title: 'Repo health', data: '—', fixtures: [], run: v11 },
  {
    id: 'V12',
    title: 'V2 dashboard values',
    data: 'F1 + F2',
    fixtures: ['F1', 'F2'],
    run: both(v12F1, v12F2),
  },
  {
    id: 'V13',
    title: 'Products + distributions views',
    data: 'F1 + F2',
    fixtures: ['F1', 'F2'],
    run: both(v13F1, v13F2),
  },
  { id: 'V14', title: 'Health view', data: 'F1', fixtures: ['F1'], run: v14 },
  { id: 'V15', title: 'SRM + planning helpers', data: 'F3', fixtures: ['F3'], run: v15 },
  { id: 'V16', title: 'Sync lifecycle', data: 'F1', fixtures: ['F1'], run: v16 },
  { id: 'V17', title: 'FX', data: 'F1 + fixture', fixtures: ['F1'], run: v17 },
];

/**
 * Execution order: reads of the freshly loaded fixtures first; V3 (moves
 * F1's subscription and back), V16 (restarts the modeler), V8 (exhausts a
 * rate-limit bucket) later; the external tools last.
 */
const ORDER: readonly FlowId[] = [
  'V1',
  'V2',
  'V5',
  'V12',
  'V13',
  'V14',
  'V17',
  'V3',
  'V4',
  'V6',
  'V7',
  'V15',
  'V8',
  'V16',
  'V10',
  'V9',
  'V11',
];

export interface Selection {
  readonly flows: readonly FlowDef[];
  readonly fixtures: ReadonlySet<FixtureId>;
}

/**
 * `--only V4,V7` → those flows and their fixtures; `--only F1` → every flow
 * that reads F1, loading only F1 (checks on other fixtures are skipped).
 */
export function select(only: ReadonlySet<string> | null): Selection {
  if (only === null) {
    return { flows: ORDER.map(byId), fixtures: new Set<FixtureId>(['F1', 'F2', 'F3']) };
  }
  const fixtureIds = [...only].filter((id): id is FixtureId => /^F\d$/.test(id));
  const flowIds = new Set([...only].filter((id) => /^V\d+$/.test(id)));
  const flows = ORDER.map(byId).filter(
    (f) => flowIds.has(f.id) || f.fixtures.some((x) => fixtureIds.includes(x)),
  );
  const fixtures = new Set<FixtureId>(fixtureIds);
  for (const f of flows) if (flowIds.has(f.id)) for (const x of f.fixtures) fixtures.add(x);
  return { flows, fixtures };
}

function byId(id: FlowId): FlowDef {
  const f = FLOWS.find((x) => x.id === id);
  if (!f) throw new Error(`no flow ${id}`);
  return f;
}

export async function runFlow(
  def: FlowDef,
  ctx: FlowCtx,
  onCheck: (r: CheckResult) => void,
): Promise<FlowResult> {
  const started = performance.now();
  const checks: CheckResult[] = [];
  const check: CheckFn = async (name, body) => {
    const t0 = performance.now();
    let result: CheckResult;
    try {
      const o = await body();
      result = { name, ...o, ms: performance.now() - t0 } as CheckResult;
    } catch (err) {
      result =
        err instanceof FixtureNotLoaded
          ? { name, status: 'skipped', detail: err.message, ms: performance.now() - t0 }
          : {
              name,
              status: 'fail',
              detail: `error: ${errorMessage(err)}`,
              ms: performance.now() - t0,
            };
    }
    checks.push(result);
    onCheck(result);
  };
  try {
    await def.run(ctx, check);
  } catch (err) {
    checks.push({ name: 'flow', status: 'fail', detail: `error: ${errorMessage(err)}`, ms: 0 });
  }
  return { id: def.id, title: def.title, data: def.data, checks, ms: performance.now() - started };
}
