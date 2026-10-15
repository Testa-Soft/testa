import { describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import { itemRowsFromEvent, rowFromEvent } from '../row-mapper.ts';

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
    screen_w: 1920,
    screen_h: 1080,
    exp: [],
    server_ts: 1730902400500,
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: '',
    os: '',
    os_name: '',
    os_version: '',
    browser_name: '',
    browser_version: '',
    referrer_domain: '(direct)',
    channel: 'Direct',
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

describe('rowFromEvent — PRD-006 fields (task 5.4)', () => {
  const prd006 = makeEvent({
    event_name: 'purchase',
    exp: [
      [1717, 101, 1760433600, 1],
      [1802, 200, 1760431800, 3],
    ],
    goal_id: 12,
    purchase_type: 'upsell',
    parent_order_id: 'O-1',
    order_id: 'O-1-U1',
    page_type: 'thank_you',
    cart_id: 'c_8f2a',
    utm_term: 'merino',
    utm_content: 'ad-1',
    screen_w: 390,
    screen_h: 844,
    visit_number: 3,
    entry_referrer: 'https://www.google.com/',
    entry_url: 'https://shop.example/?utm_source=google',
    entry_utm_source: 'google',
    entry_utm_medium: 'cpc',
    entry_utm_campaign: 'autumn',
    entry_utm_term: 'merino',
    entry_utm_content: 'ad-1',
    click_id_type: 'gclid',
    os_name: 'iOS',
    os_version: '17.5',
    browser_name: 'Safari',
    browser_version: '17',
    referrer_domain: 'google.com',
    channel: 'Paid Search',
  });

  it('unzips exp into parallel arrays', () => {
    const row = rowFromEvent(prd006);
    expect([row.exp_ids, row.exp_var_ids, row.exp_session_starts, row.exp_session_idx]).toEqual([
      [1717, 1802],
      [101, 200],
      [1760433600, 1760431800],
      [1, 3],
    ]);
  });

  it('maps every new scalar column', () => {
    const row = rowFromEvent(prd006);
    expect(row).toMatchObject({
      goal_id: 12,
      purchase_type: 'upsell',
      parent_order_id: 'O-1',
      page_type: 'thank_you',
      cart_id: 'c_8f2a',
      utm_term: 'merino',
      utm_content: 'ad-1',
      screen_w: 390,
      screen_h: 844,
      visit_number: 3,
      entry_referrer: 'https://www.google.com/',
      entry_url: 'https://shop.example/?utm_source=google',
      entry_utm_source: 'google',
      entry_utm_medium: 'cpc',
      entry_utm_campaign: 'autumn',
      entry_utm_term: 'merino',
      entry_utm_content: 'ad-1',
      click_id_type: 'gclid',
      os_name: 'iOS',
      os_version: '17.5',
      browser_name: 'Safari',
      browser_version: '17',
      referrer_domain: 'google.com',
      channel: 'Paid Search',
    });
  });

  it('defaults every new column when absent (incl. a pre-PRD-006 event without exp)', () => {
    const { exp: _exp, referrer_domain: _r, channel: _c, ...old } = makeEvent();
    const row = rowFromEvent(old as typeof prd006);
    expect(row).toMatchObject({
      exp_ids: [],
      exp_var_ids: [],
      exp_session_starts: [],
      exp_session_idx: [],
      goal_id: 0,
      purchase_type: '',
      parent_order_id: '',
      page_type: '',
      cart_id: '',
      visit_number: 0,
      entry_referrer: '',
      click_id_type: '',
      referrer_domain: '',
      channel: '',
    });
  });
});

describe('itemRowsFromEvent (task 5.4)', () => {
  it('one row per item, carrying event_id, order_id, purchase_type, exp_ids; product_id defaults to item_id', () => {
    const ev = makeEvent({
      event_name: 'purchase',
      order_id: 'O-1',
      purchase_type: 'initial',
      currency: 'EUR',
      exp: [[1717, 101, 1760433600, 1]],
      items: [
        {
          item_id: 'SW-MER-NVY-M',
          product_id: 'SW-MER',
          item_name: 'Merino',
          item_variant: 'Navy / M',
          price: 89,
          quantity: 2,
          index: 3,
        },
        { item_id: 'SCF-WL-GRY' },
      ],
    });
    const rows = itemRowsFromEvent(ev);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event_id: ev.event_id,
      client_ts: '2024-11-06 14:13:20.123',
      order_id: 'O-1',
      purchase_type: 'initial',
      currency: 'EUR',
      exp_ids: [1717],
      item_id: 'SW-MER-NVY-M',
      product_id: 'SW-MER',
      item_variant: 'Navy / M',
      price: 89,
      quantity: 2,
      position: 3,
    });
    expect(rows[1]).toMatchObject({
      item_id: 'SCF-WL-GRY',
      product_id: 'SCF-WL-GRY',
      price: 0,
      quantity: 1,
      position: 0,
    });
  });

  it('no items → no rows', () => {
    expect(itemRowsFromEvent(makeEvent())).toEqual([]);
  });
});
