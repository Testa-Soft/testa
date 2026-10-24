/**
 * admin-v2 goals (CONTRACT "Experiments API"): the three goal forms on a v2
 * experiment create, `invalid_goals` 422s, codes on experiment info / filter,
 * and the published collector config compiling `starts_with` to a regex.
 */

import { type CheckDef, Diff, fail } from '../../lib/check.ts';
import { http, field } from '../../lib/http.ts';
import { e2eArtisan } from '../../stack/crobot.ts';
import {
  api,
  createExperiment,
  createExperimentOrThrow,
  dataOf,
  experimentInfo,
  invalidGoals,
  projectPath,
  setStatus,
  str,
} from './support.ts';

const OWNER = 'admin-v2 Goals';
/** Custom page_view goal saved to the library from the experiment form. */
export const STARTS_WITH_ACTION = '/checkout/step?(1)';
const EXPECTED_REGEX = '^/checkout/step\\?\\(1\\)';

interface GoalsFact {
  readonly identifier: number;
  readonly libraryCode: string;
  readonly pageCode: string;
}

const FACT = 'admin-v2.goals';

const INVALID_CASES: readonly {
  readonly name: string;
  readonly goals: readonly unknown[];
  readonly index: number;
  readonly reason: string;
}[] = [
  {
    name: 'two primaries',
    goals: [
      { code: 'E1', rank: 'primary' },
      { code: 'E2', rank: 'primary' },
    ],
    index: 1,
    reason: 'multiple_primary',
  },
  {
    name: 'same preset twice',
    goals: [
      { code: 'E1', rank: 'primary' },
      { code: 'E1', rank: 'secondary' },
    ],
    index: 1,
    reason: 'duplicate_code',
  },
  {
    name: 'unknown library code',
    goals: [
      { code: 'E1', rank: 'primary' },
      { code: 'G999', rank: 'secondary' },
    ],
    index: 1,
    reason: 'unknown_code',
  },
  {
    name: 'every on a preset',
    goals: [{ code: 'E2', rank: 'primary', count_mode: 'every' }],
    index: 0,
    reason: 'count_mode_every_on_preset',
  },
  {
    name: 'page_view without match_type',
    goals: [{ title: 'T', type: 'page_view', action: '/t', rank: 'primary' }],
    index: 0,
    reason: 'match_type_required',
  },
];

function goalsFact(facts: Map<string, unknown>): GoalsFact {
  const f = facts.get(FACT) as GoalsFact | undefined;
  if (f === undefined) throw new Error('admin-v2.goals.create did not record its experiment');
  return f;
}

export const adminV2GoalChecks: readonly CheckDef[] = [
  {
    id: 'admin-v2.goals.create',
    layer: 'admin-v2',
    title:
      'v2 create with preset {code:E1,primary} + library ref + custom page_view starts_with (save_to_library) → codes on experiment info',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Experiments API', 'Goal codes'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const lib = await api(ctx, 'POST', projectPath(ctx, '/goals'), {
        title: 'AV2 CTA click',
        type: 'click',
        action: '.av2-x0-cta',
      });
      const libraryCode = field(dataOf(lib), 'code');
      if (lib.status !== 201 || typeof libraryCode !== 'string') {
        return fail(`POST /projects/{uuid}/goals → ${lib.status}: ${lib.text.slice(0, 300)}`);
      }
      const identifier = await createExperimentOrThrow(ctx, 'AV2 X0 goal forms', [
        { code: 'E1', rank: 'primary' },
        { code: libraryCode, rank: 'secondary' },
        {
          title: 'AV2 checkout pages',
          type: 'page_view',
          action: STARTS_WITH_ACTION,
          match_type: 'starts_with',
          rank: 'secondary',
          save_to_library: true,
        },
      ]);
      const info = await experimentInfo(ctx, identifier);
      const goals = info.goals;
      const pick = (g: Record<string, unknown>) => ({
        code: g.code,
        kind: g.kind,
        count_mode: g.count_mode,
        rank: g.rank,
        match_type: g.match_type,
        in_library: g.in_library,
        has_project_goal: typeof g.project_goal_id === 'number',
      });
      const pageCode = String(goals[2]?.code ?? '');
      ctx.facts.set(FACT, { identifier, libraryCode, pageCode } satisfies GoalsFact);
      const lst = await api(ctx, 'GET', projectPath(ctx, '/goals'));
      const listed = ((field(lst.json, 'data') ?? []) as Record<string, unknown>[]).map(
        (g) => g.code,
      );
      const d = new Diff()
        .eq(
          'goals[0]',
          {
            code: 'E1',
            kind: 'ecommerce',
            count_mode: 'unique',
            rank: 'primary',
            match_type: null,
            in_library: null,
            has_project_goal: false,
          },
          pick({ ...goals[0] }),
        )
        .eq(
          'goals[1]',
          {
            code: libraryCode,
            kind: 'custom',
            count_mode: 'unique',
            rank: 'secondary',
            match_type: null,
            in_library: true,
            has_project_goal: true,
          },
          pick({ ...goals[1] }),
        )
        .eq(
          'goals[2]',
          {
            code: pageCode,
            kind: 'custom',
            count_mode: 'unique',
            rank: 'secondary',
            match_type: 'starts_with',
            in_library: true,
            has_project_goal: true,
          },
          pick({ ...goals[2] }),
        )
        .truthy('page goal got a new G code', /^G\d+$/.test(pageCode) && pageCode !== libraryCode)
        .truthy(
          'save_to_library put the page goal in the library list',
          listed.includes(pageCode),
          `library codes ${JSON.stringify(listed)}`,
        );
      return d.outcome(`experiment ${identifier}: E1, ${libraryCode}, ${pageCode}`, {
        goals: goals.map(pick),
      });
    },
  },
  {
    id: 'admin-v2.goals.invalid-422',
    layer: 'admin-v2',
    title:
      'invalid_goals 422 {error,index,reason}: multiple_primary, duplicate_code, unknown_code, count_mode_every_on_preset, match_type_required',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Experiments API validation'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const d = new Diff();
      for (const c of INVALID_CASES) {
        const res = await createExperiment(ctx, `AV2 invalid ${c.name}`, c.goals);
        d.eq(
          c.name,
          { status: 422, error: 'invalid_goals', index: c.index, reason: c.reason },
          invalidGoals(res),
        );
      }
      const list = await api(
        ctx,
        'GET',
        `/experiments/filter?term=${encodeURIComponent('AV2 invalid')}`,
      );
      const created = ((dataOf(list) ?? []) as unknown[]).length;
      d.eq('no experiment created by a refused request', 0, created);
      return d.outcome(`${INVALID_CASES.length} refusals with the contract shape`);
    },
  },
  {
    id: 'admin-v2.goals.filter',
    layer: 'admin-v2',
    title: 'GET /experiments/filter items carry updated_at + goal_codes[] (goal order)',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT GET /experiments/filter'],
    needs: ['admin-v2.goals.create'],
    async run(ctx) {
      const f = goalsFact(ctx.facts);
      const res = await api(
        ctx,
        'GET',
        `/experiments/filter?project_uuid=${ctx.cfg.ids.projectUuid}&term=${encodeURIComponent('AV2 X0 goal forms')}`,
      );
      const items = (dataOf(res) ?? []) as Record<string, unknown>[];
      const item = items.find((i) => Number(i.identifier) === f.identifier);
      if (res.status !== 200 || item === undefined) {
        return fail(
          `experiment ${f.identifier} not in filter (${res.status}): ${res.text.slice(0, 300)}`,
        );
      }
      return new Diff()
        .eq('goal_codes', ['E1', f.libraryCode, f.pageCode], item.goal_codes)
        .truthy(
          'updated_at is "Y-m-d H:i:s"',
          typeof item.updated_at === 'string' &&
            /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(item.updated_at),
          `got ${str(item.updated_at)}`,
        )
        .outcome(`updated_at ${str(item.updated_at)}, goal_codes ${str(item.goal_codes)}`);
    },
  },
  {
    id: 'admin-v2.goals.config-starts-with',
    layer: 'admin-v2',
    title:
      'published config (crobot publish → collector POST /api/v1/config) has the starts_with goal as regex ^ + escaped action',
    owner: 'admin-v2 Collector',
    dod: ['admin-v2 CONTRACT starts_with compile', 'apps/collector/src/config/build.ts'],
    needs: ['admin-v2.goals.create', 'infra.collector'],
    async run(ctx) {
      const f = goalsFact(ctx.facts);
      await setStatus(ctx, f.identifier, 'active');
      const published = await e2eArtisan(ctx.cfg, 'publish-config');
      if (!published.ok) return fail(`e2e:analytics publish-config: ${published.error}`);
      const res = await http({
        url: `${ctx.cfg.collector.url}/api/v1/config/${ctx.cfg.ids.projectUuid}`,
      });
      const experiments = (field(res.json, 'experiments') ?? []) as Record<string, unknown>[];
      const exp = experiments.find((e) => Number(e.experiment_id) === f.identifier);
      if (exp === undefined) {
        return fail(
          `experiment ${f.identifier} missing from the served config`,
          f.identifier,
          experiments.map((e) => e.experiment_id),
        );
      }
      const goals = (exp.goals ?? []) as Record<string, unknown>[];
      const page = goals.find((g) => g.type === 'page_view');
      return new Diff()
        .eq(
          'page_view goal',
          { action: EXPECTED_REGEX, match_type: 'regex' },
          page ? { action: page.action, match_type: page.match_type } : null,
        )
        .truthy(
          'regex matches the prefix',
          page !== undefined && new RegExp(String(page.action)).test(`${STARTS_WITH_ACTION}/x`),
        )
        .outcome(`served goal ${str(page)}`, { goals });
    },
  },
];
