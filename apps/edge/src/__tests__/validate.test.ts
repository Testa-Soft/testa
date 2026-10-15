import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, validateEvent } from '../validate.ts';

const base = {
  event_id: '01923a4f-7000-7d9c-bb8f-1234567890ab',
  event_name: 'purchase',
  client_ts: 1_760_433_600_000,
  project_id: 42,
  visitor_id: 'v1',
  session_id: 's1',
  url: 'https://shop.example/thanks',
  consent_state: 'granted',
  tracker_version: '4.1.0',
  viewport_w: 390,
  viewport_h: 844,
  screen_w: 390,
  screen_h: 844,
  exp: [[1717, 101, 1760433600, 1]],
  order_id: 'O-1',
  value_native: 211.2,
  currency: 'EUR',
  purchase_type: 'initial',
  items: [{ item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 }],
};

const ok = (raw: unknown) => {
  const r = validateEvent(raw);
  if (!r.ok) throw new Error(r.reason);
  return r.event as unknown as Record<string, unknown>;
};
const rejected = (raw: unknown) => validateEvent(raw).ok === false;

describe('validateEvent — accept', () => {
  it.each<[string, object]>([
    ['the PRD purchase example', {}],
    ['upsell with parent_order_id', { purchase_type: 'upsell', parent_order_id: 'O-0' }],
    ['item without price / quantity', { items: [{ item_id: 'X' }] }],
    ['price 0, quantity 9999', { items: [{ item_id: 'X', price: 0, quantity: 9999 }] }],
    ['no items, no exp (old pixel)', { items: undefined, exp: undefined }],
    ['3-field exp tuple (older pixel)', { exp: [[1717, 101, 1760433600]] }],
    ['custom event', { event_name: 'size_guide_opened', items: undefined }],
  ])('%s', (_n, patch) => {
    expect(rejected({ ...base, ...patch })).toBe(false);
  });
});

describe('validateEvent — reject', () => {
  it.each<[string, object]>([
    ['upsell without parent_order_id', { purchase_type: 'upsell' }],
    ['unknown purchase_type', { purchase_type: 'recurring' }],
    ['empty item_id', { items: [{ item_id: '' }] }],
    ['item_id over 128 chars', { items: [{ item_id: 'x'.repeat(129) }] }],
    ['negative price', { items: [{ item_id: 'X', price: -1 }] }],
    ['quantity 0', { items: [{ item_id: 'X', quantity: 0 }] }],
    ['quantity 10000', { items: [{ item_id: 'X', quantity: 10_000 }] }],
    ['fractional quantity', { items: [{ item_id: 'X', quantity: 1.5 }] }],
    ['item string over 256', { items: [{ item_id: 'X', item_name: 'n'.repeat(257) }] }],
    ['exp with negative id', { exp: [[-1, 101, 1, 1]] }],
    ['exp with 2 fields', { exp: [[1717, 101]] }],
    ['exp with a float', { exp: [[1717, 101.5, 1, 1]] }],
    ['missing event_id', { event_id: '' }],
    ['client_ts not a number', { client_ts: 'now' }],
  ])('%s', (_n, patch) => {
    expect(rejected({ ...base, ...patch })).toBe(true);
  });
});

describe('validateEvent — normalisation', () => {
  it('checkout_start → begin_checkout', () => {
    expect(ok({ ...base, event_name: 'checkout_start' }).event_name).toBe('begin_checkout');
  });

  it('derives items_count from quantities (default 1); keeps an explicit one', () => {
    expect(
      ok({ ...base, items: [{ item_id: 'A', quantity: 2 }, { item_id: 'B' }] }).items_count,
    ).toBe(3);
    expect(ok({ ...base, items_count: 7 }).items_count).toBe(7);
  });

  it(`truncates to ${MAX_ITEMS} items and flags props._items_truncated`, () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ item_id: `I${i}` }));
    const e = ok({ ...base, items, props: { coupon: 'X' } });
    expect((e.items as unknown[]).length).toBe(MAX_ITEMS);
    expect(e.props).toEqual({ coupon: 'X', _items_truncated: 1 });
    expect(e.items_count).toBe(MAX_ITEMS);
  });

  it('normalises exp to 4-tuples and defaults screen + exp for old pixels', () => {
    expect(ok({ ...base, exp: [[1717, 101, 1760433600]] }).exp).toEqual([
      [1717, 101, 1760433600, 0],
    ]);
    const old = ok({ ...base, exp: undefined, screen_w: undefined, screen_h: undefined });
    expect([old.exp, old.screen_w, old.screen_h]).toEqual([[], 0, 0]);
  });

  it('drops unknown page_type / click_id_type values and unknown item keys', () => {
    const e = ok({
      ...base,
      page_type: 'landing',
      click_id_type: 'dclid',
      items: [{ item_id: 'A', bogus: 1 }],
    });
    expect('page_type' in e).toBe(false);
    expect('click_id_type' in e).toBe(false);
    expect(e.items).toEqual([{ item_id: 'A' }]);
    const kept = ok({ ...base, page_type: 'thank_you', click_id_type: 'gclid' });
    expect([kept.page_type, kept.click_id_type]).toEqual(['thank_you', 'gclid']);
  });
});
