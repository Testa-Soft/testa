/**
 * Fixture F3 (docs/prds/006-validation.md "Fixture F3 — stats golden") as wire
 * events: exactly 4,737 / 4,790 / 4,702 exposed visitors in variations
 * 100 / 101 / 102 with 115 / 137 / 109 purchasers, one initial purchase each,
 * value €90. All on D1 (2026-10-01), one session per visitor.
 *
 * The cross-repo harness runs it as its own experiment (default 1903) in the
 * F1 project, so crobot's sync → stats → label path can be checked live
 * (crobot PRD §9: "Labels correct for F3 (91% → Inconclusive at 95%)").
 */

import type { WireEvent } from './f1-wire.ts';
import { uuidFor } from './ids.ts';

export const F3_COUNTS = [
  { variation: 100, visitors: 4737, purchasers: 115 },
  { variation: 101, visitors: 4790, purchasers: 137 },
  { variation: 102, visitors: 4702, purchasers: 109 },
] as const;

export const F3_ORDER_VALUE = 90;

const D1_MS = Date.parse('2026-10-01T00:00:00Z');

interface Envelope {
  readonly client_ts: number;
  readonly server_ts: number;
  readonly project_id: number;
  readonly visitor_id: string;
  readonly [key: string]: unknown;
}

export function envelope(visitor: string, ts: number, projectId: number): Envelope {
  return {
    client_ts: ts,
    server_ts: ts + 150,
    project_id: projectId,
    visitor_id: visitor,
    session_id: `s-${visitor}`,
    url: 'https://shop.example/product/f3',
    consent_state: 'granted',
    tracker_version: '4.1.0',
    viewport_w: 1440,
    viewport_h: 900,
    screen_w: 1512,
    screen_h: 982,
    country: 'LT',
    region: 'Vilnius County',
    region_subdivision: 'Vilnius County',
    city: 'Vilnius',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS 14.5',
    os_name: 'macOS',
    browser_name: 'Chrome',
    is_bot: 0,
    in_experiment: 1,
    channel: 'Direct',
    referrer_domain: '(direct)',
  };
}

export function buildF3WireEvents(projectId: number, experimentId: number): WireEvent[] {
  const events: WireEvent[] = [];
  let offsetSec = 0;
  for (const { variation, visitors, purchasers } of F3_COUNTS) {
    for (let i = 0; i < visitors; i++) {
      offsetSec += 5;
      const visitor = `f3-${experimentId}-${variation}-${i}`;
      const viewTs = D1_MS + offsetSec * 1000;
      const start = Math.floor(viewTs / 1000);
      const exp = [[experimentId, variation, start, 1]];
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
          ...envelope(visitor, viewTs + 120_000, projectId),
          event_id: uuidFor(`${visitor}|purchase`),
          event_name: 'purchase',
          exp,
          purchase_type: 'initial',
          order_id: `F3-${experimentId}-${variation}-${i}`,
          value_native: F3_ORDER_VALUE,
          currency: 'EUR',
          items_count: 1,
          items: [{ item_id: 'SKU-F3', product_id: 'SKU-F3', price: F3_ORDER_VALUE, quantity: 1 }],
        });
      }
    }
  }
  return events;
}
