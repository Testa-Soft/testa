/** PRD-006 §1.7 example payloads from the typed helpers (task 5.7). */
import { describe, expect, it } from 'vitest';
import {
  addToCart,
  beginCheckout,
  itemsValue,
  lead,
  paymentInfo,
  purchase,
  shippingInfo,
  signUp,
} from '../track.ts';

const SWEATER = {
  item_id: 'SW-MER-NVY-M',
  product_id: 'SW-MER',
  item_name: 'Merino Crew Sweater',
  item_category: 'Apparel',
  price: 89,
  quantity: 2,
};
const SCARF = { item_id: 'SCF-WL-GRY', product_id: 'SCF-WL', price: 49, quantity: 1 };

describe('typed helpers reproduce the PRD §1.7 examples', () => {
  it('add_to_cart', () => {
    expect(addToCart([SWEATER], { currency: 'EUR', cart_id: 'c_8f2a' })).toEqual([
      'add_to_cart',
      { value_native: 178, currency: 'EUR', cart_id: 'c_8f2a', items: [SWEATER] },
    ]);
  });

  it('begin_checkout → add_shipping_info → add_payment_info', () => {
    expect(
      beginCheckout([SWEATER, SCARF], { currency: 'EUR', cart_id: 'c_8f2a' })[1],
    ).toMatchObject({
      value_native: 227,
      currency: 'EUR',
      cart_id: 'c_8f2a',
    });
    expect(shippingInfo({ cart_id: 'c_8f2a' })).toEqual([
      'add_shipping_info',
      { cart_id: 'c_8f2a' },
    ]);
    expect(
      paymentInfo({ payment_type: 'apple_pay', cart_id: 'c_8f2a', value: 227, currency: 'EUR' }),
    ).toEqual([
      'add_payment_info',
      { payment_type: 'apple_pay', cart_id: 'c_8f2a', value_native: 227, currency: 'EUR' },
    ]);
    expect(() => paymentInfo({ payment_type: '' })).toThrow(/payment_type/);
  });

  it('purchase (initial): value excludes tax + shipping, net of the order discount', () => {
    expect(
      purchase({
        order_id: 'ORD-20261014-0042',
        currency: 'EUR',
        cart_id: 'c_8f2a',
        items: [
          { item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 },
          { item_id: 'SCF-WL-GRY', product_id: 'SCF-WL', price: 49, quantity: 1 },
        ],
        discount: 15.8,
        tax: 37.5,
        shipping: 4.9,
        coupon: 'AUTUMN10',
      }),
    ).toEqual([
      'purchase',
      {
        order_id: 'ORD-20261014-0042',
        purchase_type: 'initial',
        value_native: 211.2,
        currency: 'EUR',
        cart_id: 'c_8f2a',
        items_count: 3,
        items: [
          { item_id: 'SW-MER-NVY-M', product_id: 'SW-MER', price: 89, quantity: 2 },
          { item_id: 'SCF-WL-GRY', product_id: 'SCF-WL', price: 49, quantity: 1 },
        ],
        tax: 37.5,
        shipping: 4.9,
        discount: 15.8,
        coupon: 'AUTUMN10',
      },
    ]);
  });

  it('purchase (upsell) needs parent_order_id', () => {
    expect(
      purchase({
        order_id: 'ORD-20261014-0042-U1',
        parent_order_id: 'ORD-20261014-0042',
        purchase_type: 'upsell',
        currency: 'EUR',
        items: [{ item_id: 'SOCK-WL-3P', product_id: 'SOCK-WL', price: 24, quantity: 1 }],
        upsell_offer_id: 'pp_socks_v2',
      })[1],
    ).toMatchObject({
      purchase_type: 'upsell',
      parent_order_id: 'ORD-20261014-0042',
      value_native: 24,
      items_count: 1,
      upsell_offer_id: 'pp_socks_v2',
    });
    expect(() =>
      purchase({ order_id: 'U', currency: 'EUR', items: [], purchase_type: 'upsell' }),
    ).toThrow(/parent_order_id/);
  });

  it('generate_lead / sign_up', () => {
    expect(lead({ lead_type: 'quote', form_id: 'b2b_quote' })).toEqual([
      'generate_lead',
      { lead_type: 'quote', form_id: 'b2b_quote' },
    ]);
    expect(signUp({ method: 'email' })).toEqual(['sign_up', { method: 'email' }]);
  });

  it('itemsValue: missing quantity = 1, missing price = 0, float-safe', () => {
    expect(
      itemsValue([{ item_id: 'a', price: 0.1 }, { item_id: 'b', price: 0.2 }, { item_id: 'c' }]),
    ).toBe(0.3);
  });
});
