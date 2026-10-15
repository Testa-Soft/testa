/**
 * R3 tenant fixture: a SECOND project that reuses the F1 experiment
 * identifier (crobot identifiers are unique per project only). Small and
 * deliberately different from F1 so any cross-project leak shows up in the
 * numbers. All on D1 (2026-10-01), EUR, one session per visitor.
 *
 *   variation 100: 3 exposed visitors, 1 purchaser (€40)
 *   variation 101: 2 exposed visitors, 2 purchasers (€25 each)
 */

import type { WireEvent } from './f1-wire.ts';
import { envelope } from './f3-wire.ts';
import { uuidFor } from './ids.ts';

export const TENANT_PROJECT_ID = 43;
export const TENANT_PROJECT_UUID = 'e2e00000-0000-4000-8000-000000000043';

export const TENANT_COUNTS = [
  { variation: 100, visitors: 3, purchasers: 1, orderValue: 40 },
  { variation: 101, visitors: 2, purchasers: 2, orderValue: 25 },
] as const;

const D1_MS = Date.parse('2026-10-01T08:00:00Z');

export function buildTenantWireEvents(projectId: number, experimentId: number): WireEvent[] {
  const events: WireEvent[] = [];
  let offsetSec = 0;
  for (const { variation, visitors, purchasers, orderValue } of TENANT_COUNTS) {
    for (let i = 0; i < visitors; i++) {
      offsetSec += 30;
      const visitor = `t${projectId}-${experimentId}-${variation}-${i}`;
      const viewTs = D1_MS + offsetSec * 1000;
      const exp = [[experimentId, variation, Math.floor(viewTs / 1000), 1]];
      events.push({
        ...envelope(visitor, viewTs, projectId),
        event_id: uuidFor(`${visitor}|view`),
        event_name: 'experiment_view',
        experiment_id: experimentId,
        variation_id: variation,
        exp,
      });
      if (i < purchasers) {
        events.push({
          ...envelope(visitor, viewTs + 60_000, projectId),
          event_id: uuidFor(`${visitor}|purchase`),
          event_name: 'purchase',
          exp,
          purchase_type: 'initial',
          order_id: `T-${projectId}-${experimentId}-${variation}-${i}`,
          value_native: orderValue,
          currency: 'EUR',
          items_count: 1,
          items: [{ item_id: 'SKU-T', product_id: 'SKU-T', price: orderValue, quantity: 1 }],
        });
      }
    }
  }
  return events;
}

/** crobot ProjectResource-shaped config for the tenant project (what POST /api/v1/config takes). */
export function tenantProjectSource(projectId: number, experimentId: number): object {
  return {
    id: projectId,
    name: 'E2E tenant (R3)',
    experiments: [
      {
        identifier: experimentId,
        platform_version: 'v2',
        title: `R3 tenant ${experimentId}`,
        url: 'https://tenant.example/',
        url_match_type: 'contains',
        traffic: 100,
        type: 'copy',
        status: 'active',
        variations: TENANT_COUNTS.map(({ variation }) => ({
          identifier: variation,
          traffic: 50,
          url_match_type: 'contains',
          changes: [],
        })),
      },
    ],
  };
}
