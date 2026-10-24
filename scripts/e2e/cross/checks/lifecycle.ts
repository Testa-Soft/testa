/**
 * Layer `lifecycle` (runs last: it changes subscriptions the UI layer reads).
 * Stopped subscription final run (V3) and unsubscribe (§3.1 DELETE).
 */

import { F1_METRICS, F1_STOPPED_TO_D2 } from '../expected/f1.ts';
import { type CheckDef, Diff } from '../lib/check.ts';
import { sumByVariation } from '../lib/derive.ts';
import { field } from '../lib/http.ts';
import {
  assertBuilt,
  platformApi,
  scopedPath,
  subscriptionBody,
  waitForReadySummary,
} from '../lib/platform-api.ts';
import { putSubscription } from './contract-sync.ts';

export const lifecycleChecks: readonly CheckDef[] = [
  {
    id: 'lifecycle.stopped-final',
    layer: 'lifecycle',
    title:
      'V3: stopped subscription to = D2 → final run: variant purchasers 1, revenue €65.00, visitors 3 / 3',
    owner: 'P4',
    dod: ['V3', 'PRD-006 §3.1 stopped'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const id = ctx.cfg.ids.f1;
      await putSubscription(
        ctx,
        id,
        subscriptionBody(ctx, F1_METRICS, { status: 'stopped', to: F1_STOPPED_TO_D2.to }),
      );
      const summary = await waitForReadySummary(
        ctx,
        id,
        180_000,
        (s) => s.to === F1_STOPPED_TO_D2.to,
      );
      const sums = sumByVariation(summary.rows);
      const variant = sums.get(101);
      // Restore the running subscription for anything that runs after this.
      await putSubscription(ctx, id, subscriptionBody(ctx, F1_METRICS));
      return new Diff()
        .eq(
          'variant purchasers',
          F1_STOPPED_TO_D2.variantPurchasers,
          variant?.keys.get('purchase')?.converted,
        )
        .near(
          'variant revenue',
          F1_STOPPED_TO_D2.variantRevenue,
          variant?.keys.get('revenue')?.sum,
          0.01,
        )
        .eq('visitors', F1_STOPPED_TO_D2.visitors, {
          100: sums.get(100)?.visitors,
          101: variant?.visitors,
        })
        .outcome(`final run ${summary.run_id}`);
    },
  },
  {
    id: 'lifecycle.unsubscribe',
    layer: 'lifecycle',
    title: 'DELETE subscription 1802 → daily-summary 404 not_subscribed',
    owner: 'P4',
    dod: ['PRD-006 §3.1 DELETE', 'crobot §7a archive'],
    needs: ['contract.1802-lifecycle'],
    async run(ctx) {
      const id = ctx.cfg.ids.f1Second;
      const del = await platformApi(ctx, {
        method: 'DELETE',
        path: scopedPath(ctx, id, 'subscription'),
      });
      assertBuilt(del, 'P4', 'DELETE subscription');
      const after = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, id, 'daily-summary'),
      });
      return new Diff()
        .truthy(`DELETE 2xx (got ${del.status})`, del.status >= 200 && del.status < 300)
        .eq('after delete', [404, 'not_subscribed'], [after.status, field(after.json, 'error')])
        .outcome('unsubscribed');
    },
  },
];
