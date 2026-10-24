/**
 * `window._testa.track*` typed helpers (task 5.7): queue-safe before load,
 * PRD §1.7 payloads on the wire (commerce fields top-level, extras in props),
 * legacy positional trackPurchase, invalid input never thrown.
 */
import type { PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { __getPendingEventsForTests, hydrate } from '../lifecycle.ts';

function project(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [
      {
        experiment_id: 17,
        status: 'active',
        traffic_allocation: 100,
        platform_version: 'v2',
        rules: [],
        variations: [{ variation_id: 170, weight: 100, changes: [] }],
        goals: [],
      },
    ],
    published_at: '2026-10-01T00:00:00.000Z',
    config_hash: 'abc',
  };
}

const ITEMS = [
  { item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 },
  { item_id: 'SCF-WL-GRY', product_id: 'SCF-WL', price: 49, quantity: 1 },
];

const sent = (): PixelEvent[] =>
  __getPendingEventsForTests()
    .map((e) => e.event)
    .filter((e): e is PixelEvent => e !== undefined);
const named = (n: string) => sent().filter((e) => e.event_name === n);

beforeEach(async () => {
  await resetPixelState();
  window.cfPrefill = { project: project() };
});

afterEach(async () => {
  await resetPixelState();
});

describe('typed helpers', () => {
  it('queue before load: calls replay in order with PRD payloads', () => {
    const stub = installQueue();
    stub.trackAddToCart([ITEMS[0]], { currency: 'EUR', cart_id: 'c_8f2a' });
    stub.trackBeginCheckout(ITEMS, { currency: 'EUR', cart_id: 'c_8f2a' });
    stub.trackShippingInfo({ cart_id: 'c_8f2a' });
    stub.trackPaymentInfo({ payment_type: 'apple_pay', value: 227, currency: 'EUR' });
    stub.trackPurchase({
      order_id: 'O-42',
      currency: 'EUR',
      items: ITEMS,
      discount: 15.8,
      tax: 37.5,
      coupon: 'AUTUMN10',
      payment_type: 'apple_pay',
    });
    stub.trackLead({ lead_type: 'quote', form_id: 'b2b_quote' });
    stub.trackSignUp({ method: 'email' });
    hydrate();

    const order = sent()
      .map((e) => e.event_name)
      .filter((n) => !['experiment_view', 'page_view', 'session_start'].includes(n));
    expect(order).toEqual([
      'add_to_cart',
      'begin_checkout',
      'add_shipping_info',
      'add_payment_info',
      'purchase',
      'generate_lead',
      'sign_up',
    ]);

    expect(named('add_to_cart')[0]).toMatchObject({
      value_native: 178,
      currency: 'EUR',
      cart_id: 'c_8f2a',
      items: [ITEMS[0]],
    });
    expect(named('begin_checkout')[0]).toMatchObject({ value_native: 227, items_count: 3 });
    expect(named('add_payment_info')[0]).toMatchObject({
      value_native: 227,
      currency: 'EUR',
      props: { payment_type: 'apple_pay' },
    });
    const purchase = named('purchase')[0];
    expect(purchase).toMatchObject({
      order_id: 'O-42',
      purchase_type: 'initial',
      value_native: 211.2,
      currency: 'EUR',
      items_count: 3,
      items: ITEMS,
      props: { tax: 37.5, discount: 15.8, coupon: 'AUTUMN10', payment_type: 'apple_pay' },
    });
    expect(named('generate_lead')[0]?.props).toEqual({ lead_type: 'quote', form_id: 'b2b_quote' });
    expect(named('sign_up')[0]?.props).toEqual({ method: 'email' });
    // All inside the experiment session.
    for (const e of sent()) expect(e.exp).toHaveLength(1);
  });

  it('live calls after load; the legacy positional trackPurchase still works', () => {
    const stub = installQueue();
    hydrate();
    stub.trackPurchase(149.99, 'EUR', 'O-legacy', 3);
    stub.trackPurchase({
      order_id: 'O-U1',
      parent_order_id: 'O-legacy',
      purchase_type: 'upsell',
      currency: 'EUR',
      items: [{ item_id: 'SOCK', price: 24 }],
    });
    const [legacy, upsell] = named('purchase');
    expect(legacy).toMatchObject({
      value_native: 149.99,
      currency: 'EUR',
      order_id: 'O-legacy',
      items_count: 3,
    });
    expect(upsell).toMatchObject({
      purchase_type: 'upsell',
      parent_order_id: 'O-legacy',
      value_native: 24,
    });
  });

  it('invalid input is reported, dropped, never thrown into the page', () => {
    const stub = installQueue();
    hydrate();
    expect(() => stub.trackPaymentInfo({})).not.toThrow();
    expect(() =>
      stub.trackPurchase({ order_id: 'U', purchase_type: 'upsell', currency: 'EUR', items: [] }),
    ).not.toThrow();
    expect(named('add_payment_info')).toEqual([]);
    expect(named('purchase')).toEqual([]);
    const errors = (window.__pixel_debug as { errors: { phase: string }[] }).errors.map(
      (e) => e.phase,
    );
    expect(errors).toEqual(
      expect.arrayContaining(['helper:trackPaymentInfo', 'helper:trackPurchase']),
    );
  });
});
