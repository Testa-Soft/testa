/**
 * Layer `contract`, R3 (CROBOT-REQUESTS): crobot experiment identifiers are
 * unique per project only. A second project reuses the F1 identifier with
 * its own data; over HTTP the two must stay isolated — subscription, modeled
 * rows, delete — and every experiment-scoped call must name its project.
 */

import { type CheckDef, Diff, fail } from '../lib/check.ts';
import { sumByVariation } from '../lib/derive.ts';
import { http, type HttpResponse, field } from '../lib/http.ts';
import {
  expPath,
  platformApi,
  scopedPath,
  subscriptionBody,
  waitForReadySummary,
} from '../lib/platform-api.ts';
import { dailySummary } from '../lib/schemas.ts';
import { ingestEvents, waitForEventRows } from '../shared/ingest-client.ts';
import {
  TENANT_COUNTS,
  TENANT_PROJECT_ID,
  TENANT_PROJECT_UUID,
  buildTenantWireEvents,
  tenantProjectSource,
} from '../shared/tenant-wire.ts';
import { compareRows, loadGolden, putSubscription } from './contract-sync.ts';

/** A project that exists nowhere: owns no experiment. */
const STRANGER_PROJECT_ID = 44;

const code = (r: HttpResponse): unknown => [
  r.status,
  field(r.json, 'error'),
  field(r.json, 'field'),
];

export const contractTenantChecks: readonly CheckDef[] = [
  {
    id: 'contract.tenant-isolation',
    layer: 'contract',
    title:
      'R3: project 43 reuses identifier 1717 with its own data → subscriptions, rows and DELETE stay per project; project_id required',
    owner: 'P4',
    dod: ['CROBOT-REQUESTS R3', 'PRD-006 §3.1 / §3.4'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const { cfg } = ctx;
      const id = cfg.ids.f1;
      const tenant = TENANT_PROJECT_ID;

      const published = await http({
        method: 'POST',
        url: `${cfg.collector.url}/api/v1/config/${TENANT_PROJECT_UUID}`,
        headers: { authorization: `Bearer ${cfg.secrets.config}` },
        body: tenantProjectSource(tenant, id),
      });
      if (published.status !== 200)
        return fail(`config publish for project ${tenant}`, 200, published.status);

      const events = buildTenantWireEvents(tenant, id);
      await ingestEvents(cfg.collector.url, cfg.secrets.ingest, events);
      await waitForEventRows(cfg.clickhouse, `project_id = ${tenant}`, events.length, 90_000);

      const get = (path: string): Promise<HttpResponse> =>
        platformApi(ctx, { method: 'GET', path });
      const noProject = await get(expPath(id, 'daily-summary'));
      const stranger = await get(scopedPath(ctx, id, 'daily-summary', {}, STRANGER_PROJECT_ID));
      const beforeSubscribe = await get(scopedPath(ctx, id, 'daily-summary', {}, tenant));

      await putSubscription(ctx, id, subscriptionBody(ctx, ['purchase'], { project_id: tenant }));
      const mine = await waitForReadySummary(ctx, id, 180_000, () => true, tenant);
      const f1Res = await get(scopedPath(ctx, id, 'daily-summary'));
      const f1 = dailySummary.safeParse(f1Res.json);

      const d = new Diff()
        .eq('no project_id', [400, 'invalid_body', 'project_id'], code(noProject))
        .eq('project 44 (owns nothing)', [404, 'experiment_not_found', undefined], code(stranger))
        .eq(
          `project ${tenant} before its PUT (42 is subscribed)`,
          [404, 'not_subscribed', undefined],
          code(beforeSubscribe),
        )
        .eq(
          `project ${tenant} keys`,
          ['purchase'],
          [...new Set(mine.rows.map((r) => r.metric_key))],
        );
      const sums = sumByVariation(mine.rows);
      for (const { variation, visitors, purchasers, orderValue } of TENANT_COUNTS) {
        const v = sums.get(variation);
        d.eq(`${tenant}/${variation} visitors`, visitors, v?.visitors)
          .eq(`${tenant}/${variation} purchasers`, purchasers, v?.keys.get('purchase')?.converted)
          .near(
            `${tenant}/${variation} revenue`,
            purchasers * orderValue,
            v?.keys.get('purchase')?.sum,
            0.01,
          );
      }
      if (!f1.success)
        return d.truthy(`project ${cfg.ids.projectId} summary parses`, false).outcome('');
      for (const mismatch of compareRows(loadGolden(ctx), f1.data.rows).list)
        d.truthy(`project ${cfg.ids.projectId} vs F1 golden: ${mismatch}`, false);
      d.truthy('different runs per project', f1.data.run_id !== mine.run_id);

      const del = await platformApi(ctx, {
        method: 'DELETE',
        path: scopedPath(ctx, id, 'subscription', {}, tenant),
      });
      const afterDelete = await get(scopedPath(ctx, id, 'daily-summary', {}, tenant));
      const f1After = await get(scopedPath(ctx, id, 'daily-summary'));
      return d
        .eq(`DELETE ${tenant}`, 200, del.status)
        .eq(`project ${tenant} after DELETE`, [404, 'not_subscribed', undefined], code(afterDelete))
        .eq(
          `project ${cfg.ids.projectId} after ${tenant}'s DELETE`,
          [200, 'ready', f1.data.rows.length],
          [
            f1After.status,
            field(f1After.json, 'status'),
            (field(f1After.json, 'rows') as unknown[] | undefined)?.length,
          ],
        )
        .outcome(
          `1717 isolated: project ${cfg.ids.projectId} run ${f1.data.run_id}, project ${tenant} run ${mine.run_id}`,
        );
    },
  },
];
