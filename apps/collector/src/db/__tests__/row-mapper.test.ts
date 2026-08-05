import { describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import { rowFromEvent } from '../row-mapper.ts';

function makeEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    event_id: '00000000-0000-0000-0000-000000000001',
    event_name: 'page_view',
    client_ts: 1730902400123,
    project_id: 1,
    visitor_id: 'v1',
    session_id: 's1',
    url: 'https://example.com/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 1280,
    viewport_h: 720,
    server_ts: 1730902400500,
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: '',
    os: '',
    is_bot: 0,
    ...overrides,
  };
}

describe('rowFromEvent — in_experiment (task 1.8)', () => {
  it('carries in_experiment=1 through to the row', () => {
    expect(rowFromEvent(makeEvent({ in_experiment: 1 })).in_experiment).toBe(1);
  });

  it('carries in_experiment=0 through to the row', () => {
    expect(rowFromEvent(makeEvent({ in_experiment: 0 })).in_experiment).toBe(0);
  });

  it('defaults in_experiment to 0 when the pixel omits it', () => {
    const ev = makeEvent();
    // biome-ignore lint/performance/noDelete: exercise the truly-absent wire case
    delete (ev as { in_experiment?: 0 | 1 }).in_experiment;
    expect(rowFromEvent(ev).in_experiment).toBe(0);
  });
});

describe('rowFromEvent — timestamp + defaults', () => {
  it('formats client_ts as a DateTime64(3) UTC string', () => {
    expect(rowFromEvent(makeEvent()).client_ts).toBe('2024-11-06 14:13:20.123');
  });

  it('coalesces missing geo/device to schema defaults', () => {
    const row = rowFromEvent(makeEvent({ country: '' }));
    expect(row.country).toBe('XX');
    expect(row.referrer).toBe('');
    expect(row.value_native).toBe(0);
  });
});
