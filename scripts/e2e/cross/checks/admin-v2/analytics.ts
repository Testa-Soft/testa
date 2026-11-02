/**
 * admin-v2 analytics API (CONTRACT "Analytics API"): envelope fields
 * (`currency`, `retry_after_ms`, status vocabulary) on every view, the
 * `i:{identifier}` routes, the project catalogue with ETag / 304, and
 * `no_data` for a never-started experiment.
 */

import { type CheckDef, Diff } from '../../lib/check.ts';
import { field } from '../../lib/http.ts';
import { STATUS_VOCAB, api, createExperimentOrThrow, projectPath, str } from './support.ts';

const OWNER = 'admin-v2 Analytics';

/** AnalyticsViewService::VIEWS with the params each needs. */
const VIEWS: readonly string[] = [
  'goal-table',
  'all-metrics',
  'trend',
  'breakdown?breakdown=device_type',
  'product-detail',
  'summary',
  'funnel',
  'revenue',
  'products',
  'segments',
  'health',
];

const PRESET_CODES = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'F1', 'F2', 'F3', 'F4'];
const METRIC_KEYS = ['direction', 'formula', 'group', 'id', 'kind', 'label', 'stats_model'];
const PRESET_KEYS = [
  'base',
  'base_label',
  'code',
  'event',
  'formula',
  'kind',
  'name',
  'params',
  'qualifier',
  'type',
];

/** Every `status` value found in data sections (one level of nesting below a section). */
function sectionStatuses(data: unknown): { path: string; status: unknown }[] {
  if (data === null || typeof data !== 'object') return [];
  return Object.entries(data as Record<string, unknown>).flatMap(([key, section]) => {
    if (section === null || typeof section !== 'object' || Array.isArray(section)) return [];
    const s = section as Record<string, unknown>;
    return 'status' in s ? [{ path: `data.${key}.status`, status: s.status }] : [];
  });
}

/** Envelope mismatches of one view response. */
function envelopeIssues(view: string, body: unknown, d: Diff): void {
  const stats = field(body, 'stats');
  const retry = field(body, 'retry_after_ms');
  d.eq(`${view} currency`, 'EUR', field(body, 'currency'))
    .truthy(
      `${view} has retry_after_ms`,
      body !== null && typeof body === 'object' && 'retry_after_ms' in body,
    )
    .truthy(
      `${view} retry_after_ms null|int`,
      retry === null || Number.isInteger(retry),
      `got ${str(retry)}`,
    )
    .truthy(
      `${view} stats.status in vocab`,
      (STATUS_VOCAB as readonly unknown[]).includes(field(stats, 'status')),
      `got ${str(field(stats, 'status'))}`,
    )
    .truthy(
      `${view} stats.status_detail kept`,
      typeof field(stats, 'status_detail') === 'string',
      `got ${str(field(stats, 'status_detail'))}`,
    );
  for (const s of sectionStatuses(field(body, 'data'))) {
    d.truthy(
      `${view} ${s.path} in vocab`,
      (STATUS_VOCAB as readonly unknown[]).includes(s.status),
      `got ${str(s.status)}`,
    );
  }
}

export const adminV2AnalyticsChecks: readonly CheckDef[] = [
  {
    id: 'admin-v2.analytics.envelope',
    layer: 'admin-v2',
    title:
      'every view (11) by i:1717: currency EUR, retry_after_ms (null|int), status ∈ ready|pending|no_data|error (+status_detail)',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Analytics envelope'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const d = new Diff();
      const seen: Record<string, unknown> = {};
      for (const view of VIEWS) {
        const res = await api(ctx, 'GET', `/experiments/i:${ctx.cfg.ids.f1}/analytics/${view}`);
        const name = view.split('?')[0] ?? view;
        if (res.status !== 200) {
          d.truthy(`${name} status 200`, false, `got ${res.status}: ${res.text.slice(0, 160)}`);
          continue;
        }
        envelopeIssues(name, res.json, d);
        seen[name] = {
          stats: field(field(res.json, 'stats'), 'status'),
          retry_after_ms: field(res.json, 'retry_after_ms'),
        };
      }
      return d.outcome(`${VIEWS.length} views carry the admin-v2 envelope`, seen);
    },
  },
  {
    id: 'admin-v2.analytics.identifier-routes',
    layer: 'admin-v2',
    title:
      '/experiments/i:{identifier}/analytics/*: i:1717 = numeric 5001; unknown → 404; v1 (1900) → 409; settings by identifier',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT i:{identifier} routing'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const byId = await api(ctx, 'GET', `/experiments/i:${ctx.cfg.ids.f1}/analytics/goal-table`);
      const numeric = await api(ctx, 'GET', '/experiments/5001/analytics/goal-table');
      const unknown = await api(ctx, 'GET', '/experiments/i:999999991/analytics/goal-table');
      const v1 = await api(
        ctx,
        'GET',
        `/experiments/i:${ctx.cfg.ids.v1Experiment}/analytics/goal-table`,
      );
      const settings = await api(ctx, 'GET', `/experiments/i:${ctx.cfg.ids.f1}/analytics/settings`);
      return new Diff()
        .eq('i:1717 status', 200, byId.status)
        .eq('i:1717 experiment_id', 5001, field(byId.json, 'experiment_id'))
        .eq(
          'same rows as numeric route',
          str(field(field(numeric.json, 'data'), 'selected')),
          str(field(field(byId.json, 'data'), 'selected')),
        )
        .eq('unknown identifier', 404, unknown.status)
        .eq('v1 experiment', 409, v1.status)
        .eq('settings by identifier', 200, settings.status)
        .outcome('identifier routes resolve inside the project');
    },
  },
  {
    id: 'admin-v2.analytics.catalogue',
    layer: 'admin-v2',
    title:
      'GET /projects/{uuid}/analytics/catalogue: metrics/dimensions/goal_presets E1–E7,F1–F4; ETag → If-None-Match 304',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT catalogue'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const path = projectPath(ctx, '/analytics/catalogue');
      const res = await api(ctx, 'GET', path);
      const data = field(res.json, 'data');
      const metrics = (field(data, 'metrics') ?? []) as Record<string, unknown>[];
      const presets = (field(data, 'goal_presets') ?? []) as Record<string, unknown>[];
      const dims = (field(data, 'dimensions') ?? []) as unknown[];
      const etag = res.headers.get('etag');
      const cached = etag
        ? await api(ctx, 'GET', path, undefined, { headers: { 'if-none-match': etag } })
        : null;
      const stale = await api(ctx, 'GET', path, undefined, {
        headers: { 'if-none-match': '"stale"' },
      });
      const e1 = presets.find((p) => p.code === 'E1');
      const e7 = presets.find((p) => p.code === 'E7');
      return new Diff()
        .eq('status', 200, res.status)
        .eq('metric keys', METRIC_KEYS, metrics[0] ? Object.keys(metrics[0]).sort() : null)
        .truthy(
          'cr metric present',
          metrics.some((m) => m.id === 'cr'),
        )
        .truthy('device_type dimension', dims.includes('device_type'), str(dims))
        .eq('preset codes', PRESET_CODES, presets.map((p) => p.code).sort())
        .eq('preset keys', PRESET_KEYS, e1 ? Object.keys(e1).sort() : null)
        .eq(
          'E1 type/kind',
          { type: 'purchase', kind: 'ecommerce' },
          { type: e1?.type, kind: e1?.kind },
        )
        .eq('E7 base_label', 'Main purchases', e7?.base_label)
        .truthy('ETag header', typeof etag === 'string' && etag.length > 0)
        .eq('If-None-Match = ETag', 304, cached?.status ?? null)
        .eq('If-None-Match stale', 200, stale.status)
        .outcome(
          `${metrics.length} metrics, ${dims.length} dimensions, ${presets.length} presets, ETag ${etag}`,
        );
    },
  },
  {
    id: 'admin-v2.analytics.no-data',
    layer: 'admin-v2',
    title:
      'never-started v2 experiment (created via API, inactive): goal-table, trend + every extras view → stats.status no_data, retry_after_ms null',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT no_data never polls forever'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const identifier = await createExperimentOrThrow(ctx, 'AV2 X0 never started', [
        { code: 'E1', rank: 'primary' },
      ]);
      const d = new Diff();
      for (const view of [
        'goal-table',
        'trend',
        'summary',
        'funnel',
        'revenue',
        'products',
        'segments',
        'health',
      ]) {
        const res = await api(ctx, 'GET', `/experiments/i:${identifier}/analytics/${view}`);
        d.eq(
          `${view}`,
          { status: 200, stats: 'no_data', retry_after_ms: null, currency: 'EUR' },
          {
            status: res.status,
            stats: field(field(res.json, 'stats'), 'status'),
            retry_after_ms: field(res.json, 'retry_after_ms'),
            currency: field(res.json, 'currency'),
          },
        );
      }
      return d.outcome(`experiment ${identifier}: no_data, no retry`);
    },
  },
];
