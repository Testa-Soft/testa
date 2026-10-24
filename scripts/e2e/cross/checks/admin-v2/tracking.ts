/**
 * admin-v2 tracking (CONTRACT "Tracking"): real purchase events go in through
 * the edge worker (`POST /track` on wrangler dev → DO batch → collector →
 * Redis → consumer → ClickHouse). crobot's listen session must see both hits
 * with their params judged, and `GET /projects/{uuid}/tracking/events` must
 * report E1 as receiving.
 */

import { randomUUID } from 'node:crypto';
import { type CheckDef, Diff, fail } from '../../lib/check.ts';
import { http, field, waitFor } from '../../lib/http.ts';
import { api, dataOf, projectPath, str } from './support.ts';

const OWNER = 'admin-v2 Tracking + Collector';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';

interface Param {
  readonly name: string;
  readonly value: unknown;
  readonly status: string;
}

function pixelPurchase(
  projectId: number,
  runId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    event_name: 'purchase',
    client_ts: Date.now(),
    project_id: projectId,
    visitor_id: `av2-track-${runId}`,
    session_id: `av2-track-s-${runId}`,
    url: 'https://shop.example/thank-you',
    consent_state: 'granted',
    tracker_version: 'av2-x0',
    viewport_w: 1440,
    viewport_h: 900,
    exp: [],
    ...extra,
  };
}

const paramsByName = (hit: unknown): Map<string, Param> =>
  new Map(((field(hit, 'params') ?? []) as Param[]).map((p) => [p.name, p]));

export const adminV2TrackingChecks: readonly CheckDef[] = [
  {
    id: 'admin-v2.tracking.listen-and-status',
    layer: 'admin-v2',
    title:
      'purchases via edge /track → collector; crobot listen session sees both hits with params judged; tracking/events E1 = receiving',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Tracking', 'collector tracking/hits + tracking/events'],
    needs: ['infra.edge', 'infra.collector', 'infra.crobot-db'],
    async run(ctx) {
      const listen = await api(ctx, 'POST', projectPath(ctx, '/tracking/listen'), { code: 'E1' });
      const session = dataOf(listen);
      const sessionId = field(session, 'id');
      if (listen.status !== 201 || typeof sessionId !== 'string') {
        return fail(`POST tracking/listen → ${listen.status}: ${listen.text.slice(0, 300)}`);
      }
      const runId = `${Date.now()}`;
      const orderId = `av2-${runId}`;
      const good = pixelPurchase(ctx.cfg.ids.projectId, runId, {
        order_id: orderId,
        value_native: 64.9,
        currency: 'EUR',
        items: [{ item_id: 'SKU-AV2', price: 64.9, quantity: 1 }],
      });
      // GA4-style names a site might copy from a gtag snippet: not read by the pipeline.
      const ga4 = pixelPurchase(ctx.cfg.ids.projectId, runId, {
        props: { transaction_id: `${orderId}-ga4`, value: '10' },
      });
      const sent = await http({
        url: `${ctx.cfg.edge.url}/track`,
        body: [good, ga4],
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      });
      if (sent.status !== 204)
        return fail(`edge /track → ${sent.status}: ${sent.text}`, 204, sent.status);

      const hits = await waitFor(
        `2 hits on listen session ${sessionId}`,
        async () => {
          const poll = await api(ctx, 'GET', projectPath(ctx, `/tracking/listen/${sessionId}`));
          const list = (field(dataOf(poll), 'hits') ?? []) as unknown[];
          return list.length >= 2 ? { status: field(dataOf(poll), 'status'), list } : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 2_000 },
      );
      const byOrder = new Map(
        hits.list.map((h) => [
          String(paramsByName(h).get('order_id')?.value ?? 'none'),
          paramsByName(h),
        ]),
      );
      const g = byOrder.get(orderId);
      const statusOf = (m: Map<string, Param> | undefined, name: string): string | undefined =>
        m?.get(name)?.status;
      const goodSeen = {
        order_id: statusOf(g, 'order_id'),
        value_native: statusOf(g, 'value_native'),
        currency: statusOf(g, 'currency'),
        'items[].price': statusOf(g, 'items[].price'),
      };
      const bad = [...byOrder.entries()].find(([k]) => k !== orderId)?.[1];
      const badSeen = {
        order_id: statusOf(bad, 'order_id'),
        value_native: statusOf(bad, 'value_native'),
        currency: statusOf(bad, 'currency'),
        items: statusOf(bad, 'items'),
      };

      // crobot caches tracking/events for 60 s; poll past one cache window.
      let e1: Record<string, unknown> | undefined;
      try {
        e1 = await waitFor(
          'tracking/events E1 receiving',
          async () => {
            const res = await api(ctx, 'GET', projectPath(ctx, '/tracking/events'));
            const row = ((dataOf(res) ?? []) as Record<string, unknown>[]).find(
              (r) => r.code === 'E1',
            );
            return row?.status === 'receiving' ? row : undefined;
          },
          { timeoutMs: 90_000, intervalMs: 5_000 },
        );
      } catch {
        const res = await api(ctx, 'GET', projectPath(ctx, '/tracking/events'));
        e1 = ((dataOf(res) ?? []) as Record<string, unknown>[]).find((r) => r.code === 'E1');
      }
      return new Diff()
        .eq('listen status', 'listening', hits.status)
        .eq(
          'good hit params',
          { order_id: 'ok', value_native: 'ok', currency: 'ok', 'items[].price': 'ok' },
          goodSeen,
        )
        .eq(
          'ga4-style hit params',
          { order_id: 'invalid', value_native: 'invalid', currency: 'missing', items: 'missing' },
          badSeen,
        )
        .eq('E1 status', 'receiving', e1?.status)
        .truthy(
          'E1 received_24h ≥ 2',
          Number(e1?.received_24h ?? 0) >= 2,
          `got ${str(e1?.received_24h)}`,
        )
        .truthy('E1 last_received_at set', typeof e1?.last_received_at === 'string')
        .outcome(
          `listen ${sessionId}: ${hits.list.length} hits; E1 ${str(e1?.status)} (${str(e1?.received_24h)} in 24 h)`,
          { e1, hits: hits.list },
        );
    },
  },
];
