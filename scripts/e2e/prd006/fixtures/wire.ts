/**
 * Envelope for the few events flows build by hand (V16, V17): every field the
 * collector's `/_ingest` schema requires (apps/collector/src/ingest/route.ts),
 * desktop / LT / Chrome, consent granted, not a bot.
 */

import type { WireEvent } from '../../cross/shared/f1-wire.ts';
import { uuidFor } from '../../cross/shared/ids.ts';

export function wireEvent(
  projectId: number,
  visitor: string,
  name: string,
  ts: number,
  extra: Readonly<Record<string, unknown>> = {},
): WireEvent {
  return {
    event_id: uuidFor(`hand|${projectId}|${visitor}|${name}|${ts}`),
    event_name: name,
    client_ts: ts,
    server_ts: ts + 150,
    project_id: projectId,
    visitor_id: visitor,
    session_id: `s-${visitor}`,
    url: 'https://shop.example/',
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
    ...extra,
  };
}

const DAY_MS = 86_400_000;

/**
 * Rows ClickHouse keeps on insert: `events` TTL (migration 015) deletes a
 * non-experiment page_view one day after its client_ts, so older ones never
 * land. The ingest wait counts only the survivors.
 */
export function expectedStored(events: readonly WireEvent[], nowMs = Date.now()): number {
  return events.filter(
    (e) => !(e.event_name === 'page_view' && e.in_experiment !== 1 && e.client_ts < nowMs - DAY_MS),
  ).length;
}
