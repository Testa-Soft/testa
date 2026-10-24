/**
 * admin-v2 retroactive goals (CONTRACT decision 1, "Metric keys"): events
 * stored BEFORE a goal exists show up as conversions once the goal is added.
 *
 * Flow per case: create + start a v2 experiment with only E1, backdate its
 * start, ingest experiment_view + the goal's events on the two previous days
 * (signed `/_ingest`), THEN add the goal, subscribe + sync, and read
 * goal-table for the goal's code (selected rows + goals[] totals/by_variation).
 *
 * Cases:
 *   page-goals.history    page_view starts_with → `page:starts_with:<enc>` (Analytics task 2, merged)
 *   custom-goals.history  custom count_mode every → `event:<name>` (analytics follow-up)
 *   goal-table.codes      unknown code 404 unknown_goal; preset / library codes resolve
 */

import { type CheckDef, type Ctx, Diff, type Outcome, fail } from '../../lib/check.ts';
import { field, waitFor } from '../../lib/http.ts';
import { waitForReadySummary } from '../../lib/platform-api.ts';
import type { WireEvent } from '../../shared/f1-wire.ts';
import { uuidFor } from '../../shared/ids.ts';
import { ingestEvents, waitForEventRows } from '../../shared/ingest-client.ts';
import { e2eArtisan } from '../../stack/crobot.ts';
import { crobotAction } from '../sync-support.ts';
import {
  api,
  createExperimentOrThrow,
  experimentInfo,
  setStatus,
  str,
  tinker,
  updateGoals,
} from './support.ts';

const DAY_MS = 86_400_000;

/** One visitor: variation index, day offset, goal events [event_name, path] they fire. */
type Visitor = readonly [number, number, readonly (readonly [string, string])[]];

interface RetroCase {
  readonly slug: string;
  readonly goal: Readonly<Record<string, unknown>>;
  readonly metricKey: string;
  readonly visitors: readonly Visitor[];
  /** Unique converters per variation index. */
  readonly conversions: readonly [number, number];
  /** Goal events per variation index (count_mode every). */
  readonly events?: readonly [number, number];
}

const PAGE_CASE: RetroCase = {
  slug: 'page',
  // Full URL: the pixel matches location.href, the collector the stored url.
  goal: {
    title: 'AV2 pricing pages',
    type: 'page_view',
    action: 'https://shop.example/pricing/',
    match_type: 'starts_with',
  },
  metricKey: `page:starts_with:${encodeURIComponent('https://shop.example/pricing/')}`,
  visitors: [
    [0, -2, [['page_view', '/pricing/plan-a']]],
    [0, -1, [['page_view', '/pricing/plan-b']]],
    [0, -2, [['page_view', '/about']]],
    [1, -2, [['page_view', '/pricing/']]],
    [1, -1, []],
    [1, -1, [['page_view', '/blog/pricing/']]],
  ],
  conversions: [2, 1],
};

const CUSTOM_CASE: RetroCase = {
  slug: 'custom',
  goal: { title: 'AV2 newsletter', type: 'custom', action: 'av2_newsletter', count_mode: 'every' },
  metricKey: 'event:av2_newsletter',
  visitors: [
    [
      0,
      -2,
      [
        ['av2_newsletter', '/'],
        ['av2_newsletter', '/blog'],
      ],
    ],
    [0, -1, [['av2_other', '/']]],
    [1, -2, [['av2_newsletter', '/']]],
    [1, -1, [['av2_newsletter', '/x']]],
    [1, -1, []],
  ],
  conversions: [1, 2],
  events: [2, 2],
};

function dayStart(offset: number): number {
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return today + offset * DAY_MS;
}

function events(
  c: RetroCase,
  projectId: number,
  experiment: number,
  variations: readonly number[],
): WireEvent[] {
  return c.visitors.flatMap(([vIdx, offset, goalEvents], i) => {
    const visitor = `av2-${c.slug}-${experiment}-${i}`;
    const t0 = dayStart(offset) + 10 * 3_600_000 + i * 60_000;
    const variation = variations[vIdx] ?? 0;
    const base = {
      project_id: projectId,
      visitor_id: visitor,
      session_id: `${visitor}-s`,
      consent_state: 'granted',
      tracker_version: 'av2-x0',
      viewport_w: 1440,
      viewport_h: 900,
      country: 'LT',
      region: '',
      region_subdivision: '',
      city: '',
      device_type: 'desktop',
      browser: 'Chrome',
      os: 'macOS',
      is_bot: 0,
      in_experiment: 1,
      exp: [[experiment, variation, Math.floor(t0 / 1000), 1]],
    };
    const view: WireEvent = {
      ...base,
      event_id: uuidFor(`av2-view|${c.slug}|${experiment}|${i}`),
      event_name: 'experiment_view',
      client_ts: t0,
      server_ts: t0 + 100,
      url: 'https://shop.example/',
      experiment_id: experiment,
      variation_id: variation,
    };
    const goalRows: WireEvent[] = goalEvents.map(([name, path], j) => ({
      ...base,
      event_id: uuidFor(`av2-goal|${c.slug}|${experiment}|${i}|${j}`),
      event_name: name,
      client_ts: t0 + 30_000 * (j + 1),
      server_ts: t0 + 30_000 * (j + 1) + 100,
      url: `https://shop.example${path}`,
    }));
    return [view, ...goalRows];
  });
}

/** Backdate started_at in the e2e DB (fixture setup; the API has no such field). */
async function backdateStart(ctx: Ctx, identifier: number, offsetDays: number): Promise<void> {
  const at = new Date(dayStart(offsetDays)).toISOString().slice(0, 19).replace('T', ' ');
  await tinker(
    ctx,
    `DB::table('experiments')->where('project_id', ${ctx.cfg.ids.projectId})->where('identifier', ${identifier})->update(['started_at' => '${at}']);`,
  );
}

async function readyGoalTable(ctx: Ctx, identifier: number, code: string) {
  return waitFor(
    `goal-table ${code} ready`,
    async () => {
      const res = await api(
        ctx,
        'GET',
        `/experiments/i:${identifier}/analytics/goal-table?goal=${code}`,
      );
      if (res.status !== 200)
        throw new Error(`goal-table → ${res.status}: ${res.text.slice(0, 200)}`);
      return field(field(res.json, 'stats'), 'status') !== 'pending' ? res : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 3_000 },
  );
}

async function runRetro(ctx: Ctx, c: RetroCase): Promise<Outcome> {
  const title = `AV2 X0 retro ${c.slug} goal`;
  const identifier = await createExperimentOrThrow(ctx, title, [{ code: 'E1', rank: 'primary' }]);
  await setStatus(ctx, identifier, 'active');
  await backdateStart(ctx, identifier, -3);
  const published = await e2eArtisan(ctx.cfg, 'publish-config');
  if (!published.ok) return fail(`publish-config: ${published.error}`);
  const before = await experimentInfo(ctx, identifier);
  const groups = [...before.groups].sort((a, b) => Number(a.identifier) - Number(b.identifier));
  const variations = groups.map((g) => Number(g.identifier));
  /** goal-table rows carry crobot variations.id; map back by identifier order. */
  const variationPks = groups.map((g) => Number(g.id));
  const evs = events(c, ctx.cfg.ids.projectId, identifier, variations);
  await ingestEvents(ctx.cfg.collector.url, ctx.cfg.secrets.ingest, evs);
  await waitForEventRows(
    ctx.cfg.clickhouse,
    `visitor_id LIKE 'av2-${c.slug}-${identifier}-%'`,
    evs.length,
    120_000,
  );

  // Only now does the goal exist.
  const upd = await updateGoals(ctx, before, title, [
    { code: 'E1', rank: 'primary' },
    { ...c.goal, rank: 'secondary', save_to_library: false },
  ]);
  if (upd.status !== 200) return fail(`update goals → ${upd.status}: ${upd.text.slice(0, 300)}`);
  const info = await experimentInfo(ctx, identifier);
  const code = String(info.goals.find((g) => g.type === c.goal.type)?.code ?? '');

  await crobotAction(ctx, 'subscribe', identifier);
  await waitForReadySummary(ctx, identifier, 240_000, (s) =>
    s.rows.some((r) => r.metric_key === c.metricKey),
  );
  await crobotAction(ctx, 'sync', identifier);
  const table = await readyGoalTable(ctx, identifier, code);

  const data = field(table.json, 'data');
  const selected = field(data, 'selected');
  const rows = (field(selected, 'rows') ?? []) as Record<string, unknown>[];
  const byVarConv = variationPks.map((pk) =>
    Number(rows.find((r) => Number(r.variation_id) === pk)?.conversions ?? Number.NaN),
  );
  const goals = (field(data, 'goals') ?? []) as Record<string, unknown>[];
  const item = goals.find((g) => g.code === code);
  const totals = field(item, 'totals');
  const byVariation = (field(item, 'by_variation') ?? []) as unknown[];
  const expectedConv = c.conversions[0] + c.conversions[1];
  const d = new Diff()
    .eq('selected.code', code, field(selected, 'code'))
    .eq('selected.count_mode', c.goal.count_mode ?? 'unique', field(selected, 'count_mode'))
    .eq('selected rows conversions per variation', [...c.conversions], byVarConv)
    .eq(
      'goals[] item keys present',
      true,
      item !== undefined &&
        ['code', 'kind', 'base_label', 'count_mode', 'totals', 'by_variation'].every(
          (k) => k in item,
        ),
    )
    .eq('goals[].totals.conversions', expectedConv, field(totals, 'conversions'))
    .eq('goals[].by_variation length', variations.length, byVariation.length)
    .truthy(
      'range starts on the backdated days',
      String(field(table.json, 'from')) <= new Date(dayStart(-2)).toISOString().slice(0, 10),
      `from ${str(field(table.json, 'from'))}`,
    );
  if (c.events) d.eq('goals[].totals.events', c.events[0] + c.events[1], field(totals, 'events'));
  return d.outcome(
    `${code} (${c.metricKey}): conversions ${str(byVarConv)}, totals ${str(totals)}`,
    { selected, item },
  );
}

const NEEDS = ['infra.collector', 'infra.consumer', 'infra.modeler', 'infra.crobot-env'];

export const adminV2PageGoalChecks: readonly CheckDef[] = [
  {
    id: 'admin-v2.page-goals.history',
    layer: 'admin-v2',
    title:
      'page_view events ingested before a page_view starts_with goal exists → after adding it, goal-table (goal=<code>) counts them',
    owner: 'admin-v2 Analytics task 2 + Collector',
    dod: ['admin-v2 CONTRACT decision 1 + 8', 'Metric keys page:'],
    needs: NEEDS,
    run: (ctx) => runRetro(ctx, PAGE_CASE),
  },
  {
    id: 'admin-v2.custom-goals.history',
    layer: 'admin-v2',
    title:
      'custom events sent before a custom (count_mode every) goal exists → after adding it, goal-table counts converters + events',
    owner: 'admin-v2 Analytics follow-up',
    dod: ['admin-v2 CONTRACT decision 1 + 4', 'Metric keys event:'],
    needs: NEEDS,
    run: (ctx) => runRetro(ctx, CUSTOM_CASE),
  },
  {
    id: 'admin-v2.goal-table.codes',
    layer: 'admin-v2',
    title:
      'goal-table ?goal=G9999 → 404 {error: unknown_goal, code}; ?goal=E3 (preset, no goal row) → 200; ?goal=<library page goal not on 1717> → 200 page: metric',
    owner: 'admin-v2 Analytics follow-up',
    dod: ['admin-v2 CONTRACT goal-table goal param'],
    needs: ['admin-v2.goals.create'],
    async run(ctx) {
      const lib = ctx.facts.get('admin-v2.goals') as { pageCode: string } | undefined;
      const base = `/experiments/i:${ctx.cfg.ids.f1}/analytics/goal-table`;
      const unknown = await api(ctx, 'GET', `${base}?goal=G9999`);
      const preset = await api(ctx, 'GET', `${base}?goal=E3`);
      const library = await api(ctx, 'GET', `${base}?goal=${lib?.pageCode ?? 'G0'}`);
      const sel = (res: typeof preset) => field(field(res.json, 'data'), 'selected');
      return new Diff()
        .eq(
          'unknown code',
          { status: 404, error: 'unknown_goal', code: 'G9999' },
          {
            status: unknown.status,
            error: field(unknown.json, 'error'),
            code: field(unknown.json, 'code'),
          },
        )
        .eq(
          'preset without a goal row',
          { status: 200, code: 'E3' },
          { status: preset.status, code: field(sel(preset), 'code') },
        )
        .eq(
          'library code not on the experiment',
          { status: 200, code: lib?.pageCode },
          { status: library.status, code: field(sel(library), 'code') },
        )
        .truthy(
          'library page goal uses a page: key',
          String(field(sel(library), 'metric_id')).startsWith('page:'),
          str(field(sel(library), 'metric_id')),
        )
        .outcome(`unknown 404; E3 and ${lib?.pageCode} resolve on 1717`);
    },
  },
];
